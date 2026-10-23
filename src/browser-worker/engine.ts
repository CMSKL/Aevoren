import { chromium, type Browser, type BrowserContext, type CDPSession, type ElementHandle, type Page } from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isIP } from "node:net";
import { z } from "zod";
import { BROWSER_FRAME_MAX_BYTES, BROWSER_TEXT_MAX_CHARACTERS } from "@shared/browser-contracts";
import type { BrowserObservation, BrowserPage, BrowserWorkerFrame, DesktopWindow } from "@shared/browser-contracts";
import { browserUrlSchema } from "@shared/browser-schemas";
import type { ControlRecord, DownloadRecord } from "./state-store";
import type { EngineAction, EngineEvent, EngineRequest, EngineResponse } from "./engine-protocol";
import { BrowserWorkerError } from "./worker-error";
import { imageDimensions } from "./image";
import { readDownload } from "./download-reader";
import { OwnedChromium } from "./chromium-control";
import { CdpDownloads } from "./cdp-downloads";
import { DesktopInput } from "./desktop-input";
import { targetFingerprint } from "./target-observation";

type PageRecord = { page: Page; session: CDPSession; id: string; version: number; createdAt: string };
type ObservationRecord = { id: string; pageId: string; epoch: number; actor: "ai" | "user"; documentVersion: number; refs: Map<string, ElementHandle>; fingerprints?: Map<string, string>; focused?: ElementHandle; focusFingerprint?: string | null };
type Input = Record<string, unknown> & { actor: "ai" | "user"; expectedEpoch: number; pageId?: string; observationId?: string; documentVersion?: number };
const send = (value: EngineResponse | EngineEvent): void => { if (process.connected) process.send?.(value); };

export class BrowserEngine {
  private context: BrowserContext | null = null;
  private browser: Browser | null = null;
  private chrome: OwnedChromium | null = null;
  private downloads: CdpDownloads | null = null;
  private readonly pages = new Map<string, PageRecord>();
  private readonly registering = new Map<Page, Promise<PageRecord>>();
  private readonly observations = new Map<string, ObservationRecord>();
  private readonly desktopObservations = new Map<string, { epoch: number; actor: "ai" | "user"; window: DesktopWindow; pageId: string | null; documentVersion: number | null }>();
  private readonly desktopInput = new DesktopInput(async (args, text) => this.runProgram("xdotool", args, text));
  private readonly active = new Set<Promise<unknown>>();
  private control: ControlRecord = { owner: "user", epoch: 0, needsObservation: true };
  private activePageId: string | null = null;
  private readonly focusWorld = `aevoren_focus_${randomUUID().replaceAll("-", "")}`;
  private lastFocusCheck: Array<{ focused: boolean; closed: boolean; stage: number; exception: boolean }> = [];
  private readonly operations = new Map<string, { cancelled: boolean; running: boolean; page: Page | null; processes: Set<ChildProcess> }>();
  private readonly focusWaiters = new Set<{ operationId: unknown; cancel(): void }>();

  constructor(readonly options: { browserSessionId: string; profileDirectory: string; downloadsDirectory: string }) {}

  async initialize(): Promise<void> {
    await mkdir(process.env.HOME!, { recursive: true, mode: 0o700 });
    const executionIp = process.env.AEVOREN_PREVIEW_EXECUTION_IP, environmentId = process.env.AEVOREN_PREVIEW_ENVIRONMENT_ID;
    if (executionIp && (isIP(executionIp) !== 4 || !z.string().uuid().safeParse(environmentId).success)) throw new BrowserWorkerError("BROWSER_PREVIEW_TARGET_INVALID", 503);
    await this.startBrowser();
  }
  private browserStarting?: Promise<void>;
  private async ensureBrowser(): Promise<void> {
    if (this.context) return;
    this.browserStarting ??= this.startBrowser().finally(() => { this.browserStarting = undefined; });
    await this.browserStarting;
  }
  private async startBrowser(): Promise<void> {
    const executionIp = process.env.AEVOREN_PREVIEW_EXECUTION_IP, environmentId = process.env.AEVOREN_PREVIEW_ENVIRONMENT_ID;
    this.chrome = new OwnedChromium(this.options.profileDirectory,
      executionIp ? `MAP *.aevoren-preview-${environmentId}.internal ${executionIp}` : undefined,
      clean => {
        for (const pageId of this.pages.keys()) this.invalidate(pageId);
        this.pages.clear(); this.desktopObservations.clear(); this.context = null; this.browser = null;
        if (!clean) send({ type: "browser-stopped" });
      });
    const rawDownloads = join(this.options.downloadsDirectory, ".cdp-raw");
    await mkdir(rawDownloads, { recursive: true, mode: 0o700 });
    try {
      const endpoint = await this.chrome.start();
      this.browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, isLocal: true, artifactsDir: rawDownloads, timeout: 30_000 });
      this.context = this.browser.contexts()[0]!;
      this.downloads = new CdpDownloads({ session: await this.browser.newBrowserCDPSession(), directory: this.options.downloadsDirectory,
        resolvePage: frameId => this.pageForFrame(frameId), currentControl: () => this.control,
        onDownload: (download, lease) => send({ type: "download", download, lease }),
        onFailure: (error, lease) => send({ type: "download-error", error, lease }) });
      await this.downloads.start();
    } catch {
      await this.chrome.close(); throw new BrowserWorkerError("BROWSER_ENGINE_START_FAILED", 503);
    }
    this.context.setDefaultTimeout(5_000);
    this.context.setDefaultNavigationTimeout(8_000);
    await Promise.all(this.context.pages().map(page => this.register(page)));
    this.context.on("page", page => { void this.register(page).catch(() => page.close().catch(() => undefined)); });
    if (this.pages.size === 0) await this.register(await this.context.newPage());
  }

  private register(page: Page): Promise<PageRecord> {
    const existing = [...this.pages.values()].find(value => value.page === page);
    if (existing) return Promise.resolve(existing);
    const pending = this.registering.get(page);
    if (pending) return pending;
    const prepared = (async () => {
      const session = await this.context!.newCDPSession(page);
      await page.setViewportSize({ width: 1_200, height: 700 });
      return this.registerReady(page, session);
    })();
    this.registering.set(page, prepared);
    void prepared.then(() => this.registering.delete(page), () => this.registering.delete(page));
    return prepared;
  }

  private registerReady(page: Page, session: CDPSession): PageRecord {
    const record = { page, session, id: randomUUID(), version: 1, createdAt: new Date().toISOString() };
    this.pages.set(record.id, record);
    this.activePageId = record.id;
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) { record.version++; this.invalidate(record.id); } });
    page.on("close", () => { this.pages.delete(record.id); this.invalidate(record.id); void session.detach().catch(() => undefined); if (this.activePageId === record.id) this.activePageId = this.pages.keys().next().value ?? null; });
    return record;
  }

  private invalidate(pageId: string): void {
    for (const [id, observation] of this.observations) {
      if (observation.pageId !== pageId) continue;
      this.observations.delete(id);
      for (const handle of [...observation.refs.values(), ...observation.focused ? [observation.focused] : []]) void handle.dispose().catch(() => undefined);
    }
  }

  private assertAccess(epoch: number, actor: "ai" | "user"): void {
    if (actor === "ai" && this.control.owner !== "ai") throw new BrowserWorkerError("BROWSER_USER_CONTROL", 409);
    if (epoch !== this.control.epoch) throw new BrowserWorkerError("BROWSER_CONTROL_CHANGED", 409);
  }

  private page(id: string | undefined): PageRecord {
    const value = this.pages.get(id ?? this.activePageId ?? "");
    if (!value || value.page.isClosed()) throw new BrowserWorkerError("BROWSER_PAGE_NOT_FOUND", 404);
    return value;
  }

  private async pageForFrame(frameId: string): Promise<string | null> {
    await Promise.allSettled([...this.registering.values()]);
    type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };
    const contains = (tree: FrameTree): boolean => tree.frame.id === frameId || Boolean(tree.childFrames?.some(contains));
    for (const record of this.pages.values()) {
      try { const tree = await record.session.send("Page.getFrameTree"); if (contains(tree.frameTree)) return record.id; }
      catch { /* A closed target cannot authorize a download association. */ }
    }
    return null;
  }

  private async focusedPage(check: () => void = () => {}): Promise<PageRecord | null> {
    const candidates = await Promise.all([...this.pages.values()].map(async record => {
      let stage = 0;
      try {
        check();
        const tree = await record.session.send("Page.getFrameTree"); stage = 1;
        check();
        const world = await record.session.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id,
          worldName: this.focusWorld, grantUniveralAccess: false }); stage = 2;
        check();
        const result = await record.session.send("Runtime.evaluate", { expression: "document.hasFocus()", contextId: world.executionContextId, returnByValue: true, silent: true }); stage = 3;
        check();
        return { record, focused: result.result.value === true, stage, exception: Boolean(result.exceptionDetails) };
      } catch { return { record, focused: false, stage, exception: false }; }
    }));
    if (process.env.AEVOREN_BROWSER_DIAGNOSTICS === "1") this.lastFocusCheck = candidates.slice(0, 20).map(({ record, focused, stage, exception }) => ({ focused, closed: !this.pages.has(record.id), stage, exception }));
    const focused = candidates.filter(value => value.focused);
    return focused.length === 1 ? focused[0]!.record : null;
  }

  private async assertFocused(record: PageRecord, check?: () => void): Promise<void> {
    if ((await this.focusedPage(check))?.id !== record.id) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
  }

  /** Only an explicit AI frame focus request may await the window manager's focus event. */
  private async awaitFrameFocus(record: PageRecord, input: Input, documentVersion: number, deadline: number): Promise<void> {
    const check = (): void => {
      this.assertAccess(input.expectedEpoch, input.actor); this.assertOperation(input);
      if (this.pages.get(record.id) !== record || record.page.isClosed() || record.version !== documentVersion) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
    };
    check();
    let reject!: (error: unknown) => void, contextId: number | undefined;
    const interrupted = new Promise<never>((_resolve, fail) => { reject = fail; });
    const waiter = { operationId: input.operationId, cancel: (): void => {
      try { check(); reject(new BrowserWorkerError("BROWSER_OPERATION_CANCELLED", 409)); } catch (error) { reject(error); }
    } };
    const key = `aevoren_focus_wait_${randomUUID().replaceAll("-", "")}`;
    const timer = setTimeout(() => reject(new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409)), Math.max(1, deadline - Date.now()));
    this.focusWaiters.add(waiter);
    const step = async <T>(work: Promise<T>): Promise<T> => { const result = await Promise.race([work, interrupted]); check(); return result; };
    try {
      if ((await step(this.focusedPage(check)))?.id === record.id) return;
      const tree = await step(record.session.send("Page.getFrameTree"));
      const world = await step(record.session.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: this.focusWorld, grantUniveralAccess: false }));
      contextId = world.executionContextId;
      const remaining = deadline - Date.now(); if (remaining <= 0) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
      const result = await step(record.session.send("Runtime.evaluate", { contextId, awaitPromise: true, returnByValue: true, silent: true,
        expression: `new Promise(resolve => { const key=${JSON.stringify(key)}; let timer; const finish=value=>{clearTimeout(timer);window.removeEventListener('focus',focused,true);delete globalThis[key];resolve(value);}; const focused=()=>{if(document.hasFocus())finish(true);}; globalThis[key]=()=>finish(false); window.addEventListener('focus',focused,true); timer=setTimeout(()=>finish(false),${remaining}); focused(); })` }));
      if (result.exceptionDetails || result.result.value !== true) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
      await step(this.assertFocused(record, check));
    } catch (error) {
      check(); if (error instanceof BrowserWorkerError) throw error;
      throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
    } finally {
      clearTimeout(timer); this.focusWaiters.delete(waiter);
      if (contextId !== undefined) void record.session.send("Runtime.evaluate", { contextId, expression: `globalThis[${JSON.stringify(key)}]?.()`, returnByValue: true, silent: true }).catch(() => undefined);
    }
  }

  private async pageDTO(record: PageRecord): Promise<BrowserPage> {
    return { id: record.id, browserSessionId: this.options.browserSessionId, url: record.page.url().slice(0, 8_192), title: (await record.page.title()).slice(0, 2_000),
      documentVersion: record.version, createdAt: record.createdAt, updatedAt: new Date().toISOString() };
  }

  private proof(input: Input): { page: PageRecord; observation: ObservationRecord } {
    this.assertAccess(input.expectedEpoch, input.actor);
    this.assertOperation(input);
    const page = this.page(input.pageId), observation = this.observations.get(input.observationId ?? "");
    if (input.actor === "ai" && this.control.needsObservation || !observation || observation.actor !== input.actor || observation.epoch !== input.expectedEpoch || observation.pageId !== page.id || observation.documentVersion !== input.documentVersion || page.version !== input.documentVersion) {
      throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
    }
    return { page, observation };
  }

  private assertOperation(input: Input): void {
    if (input.operationId && this.operations.get(String(input.operationId))?.cancelled) throw new BrowserWorkerError("BROWSER_OPERATION_CANCELLED", 409);
  }

  private remember(observation: ObservationRecord): void {
    this.observations.set(observation.id, observation);
    const sameActor = [...this.observations.values()].filter(value => value.pageId === observation.pageId && value.actor === observation.actor);
    for (const oldest of sameActor.slice(0, -10)) {
      this.observations.delete(oldest.id);
      for (const handle of [...oldest.refs.values(), ...oldest.focused ? [oldest.focused] : []]) void handle.dispose().catch(() => undefined);
    }
  }

  private async observe(record: PageRecord, epoch: number, offset = 0, maxCharacters = 18_000, actor: "ai" | "user" = "ai"): Promise<BrowserObservation> {
    const version = record.version;
    const visible = await record.page.evaluate(({ offset, maxCharacters }) => {
      const content = document.body?.innerText ?? "";
      return { text: content.slice(offset, offset + maxCharacters), truncated: content.length > offset + maxCharacters };
    }, { offset, maxCharacters: Math.min(maxCharacters, BROWSER_TEXT_MAX_CHARACTERS) });
    const elements = await record.page.$$("a[href],button,input,textarea,select,[role=button],[role=link],[contenteditable=true]");
    const selected = elements.slice(0, 500), refs = new Map<string, ElementHandle>(), fingerprints = new Map<string, string>();
    const descriptors = await Promise.all(selected.map(async element => {
      const description = await element.evaluate(node => {
        const name = node.getAttribute("aria-label") || ("labels" in node ? [...((node as HTMLInputElement).labels ?? [])].map(label => label.textContent).join(" ") : "") || node.getAttribute("placeholder") || node.textContent || "";
        return { role: node.getAttribute("role") || node.tagName.toLowerCase(), name: name.trim().slice(0, 2_000), visible: Boolean(node.getClientRects().length) };
      }).catch(() => null);
      if (!description?.visible) { await element.dispose(); return null; }
      const fingerprint = await targetFingerprint(element);
      if (!fingerprint) { await element.dispose(); return null; }
      const ref = `element_${randomUUID().replaceAll("-", "")}`;
      refs.set(ref, element); fingerprints.set(ref, fingerprint); return { ref, role: description.role.slice(0, 120), name: description.name };
    }));
    for (const element of elements.slice(500)) await element.dispose();
    try {
      this.assertAccess(epoch, actor);
      if (record.version !== version) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
      const focused = (await record.page.evaluateHandle(() => document.activeElement)).asElement() ?? undefined;
      const focusFingerprint = focused ? await targetFingerprint(focused, true) : null;
      const id = randomUUID();
      this.remember({ id, pageId: record.id, actor, epoch, documentVersion: version, refs, fingerprints, focused, focusFingerprint });
      if (actor === "ai") this.control.needsObservation = false;
      return { id, browserSessionId: this.options.browserSessionId, pageId: record.id, controlEpoch: epoch, documentVersion: version,
        url: record.page.url().slice(0, 8_192), title: (await record.page.title()).slice(0, 2_000), ...visible,
        elements: descriptors.filter(value => value !== null), truncated: visible.truncated || elements.length > 500, observedAt: new Date().toISOString() };
    } catch (error) {
      for (const element of refs.values()) await element.dispose().catch(() => undefined);
      throw error;
    }
  }

  private async runProgram(command: string, args: string[], input?: string | Buffer, operationId?: string, maxBytes = BROWSER_FRAME_MAX_BYTES): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const operation = operationId ? this.operations.get(operationId) : undefined;
      if (operation?.cancelled) { reject(new BrowserWorkerError("BROWSER_OPERATION_CANCELLED", 409)); return; }
      const diagnostic = command === "ffmpeg" && process.env.AEVOREN_BROWSER_DIAGNOSTICS === "1";
      const startedAt = Date.now(), stderr: Buffer[] = [];
      const samples: { elapsedMs: number; threads: number | null; rssKiB: number | null }[] = [];
      let stderrSize = 0;
      const child = spawn(command, args, { env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", DISPLAY: ":99", HOME: process.env.HOME }, stdio: ["pipe", "pipe", diagnostic ? "pipe" : "ignore"] });
      child.stderr?.on("data", (chunk: Buffer) => { if (stderrSize < 4_096) { const value = chunk.subarray(0, 4_096 - stderrSize); stderr.push(value); stderrSize += value.length; } });
      const sampling = diagnostic ? setInterval(() => {
        if (!child.pid || samples.length >= 50) return;
        void readFile(`/proc/${child.pid}/status`, "utf8").then(status => samples.push({ elapsedMs: Date.now() - startedAt,
          threads: Number(/^Threads:\s+(\d+)/mu.exec(status)?.[1]) || null, rssKiB: Number(/^VmRSS:\s+(\d+)/mu.exec(status)?.[1]) || null }), () => undefined);
      }, 50) : undefined;
      operation?.processes.add(child);
      const chunks: Buffer[] = []; let size = 0, settled = false;
      const finish = (error?: Error): void => {
        if (settled) return; settled = true; clearTimeout(timer); if (sampling) clearInterval(sampling); operation?.processes.delete(child);
        if (error) {
          child.kill("SIGKILL");
          if (diagnostic) void writeFile("/tmp/aevoren-ffmpeg-diagnostics.json", JSON.stringify({ program: "ffmpeg", elapsedMs: Date.now() - startedAt,
            errorCode: error.message, bytes: size, stderr: Buffer.concat(stderr).toString("utf8"), samples }), { mode: 0o600 }).catch(() => undefined).finally(() => reject(error));
          else reject(error);
        } else {
          if (diagnostic) void writeFile("/tmp/aevoren-ffmpeg-diagnostics.json", JSON.stringify({ program: "ffmpeg", elapsedMs: Date.now() - startedAt,
            errorCode: null, bytes: size, stderr: Buffer.concat(stderr).toString("utf8"), samples }), { mode: 0o600 }).catch(() => undefined).finally(() => resolve(Buffer.concat(chunks)));
          else resolve(Buffer.concat(chunks));
        }
      };
      const timer = setTimeout(() => finish(new BrowserWorkerError("BROWSER_OPERATION_TIMEOUT", 504)), 5_000);
      child.once("error", () => finish(new BrowserWorkerError("BROWSER_DESKTOP_UNAVAILABLE", 503)));
      child.once("close", code => finish(code === 0 ? undefined : new BrowserWorkerError("BROWSER_DESKTOP_OPERATION_FAILED", 502)));
      child.stdout!.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) finish(new BrowserWorkerError("BROWSER_IMAGE_TOO_LARGE", 413)); else chunks.push(chunk); });
      child.stdin!.on("error", () => undefined);
      child.stdin!.end(input);
    });
  }

  private async desktopWindow(windowId?: string): Promise<DesktopWindow> {
    const id = windowId ?? (await this.runProgram("xdotool", ["getwindowfocus"])).toString().trim();
    if (!/^\d+$/.test(id)) throw new BrowserWorkerError("BROWSER_DESKTOP_UNAVAILABLE", 503);
    const geometry = (await this.runProgram("xdotool", ["getwindowgeometry", "--shell", id])).toString();
    const values = Object.fromEntries([...geometry.matchAll(/^(X|Y|WIDTH|HEIGHT)=(-?\d+)$/gm)].map(value => [value[1], Number(value[2])]));
    if (![values.X, values.Y, values.WIDTH, values.HEIGHT].every(Number.isSafeInteger) || !values.WIDTH || !values.HEIGHT) throw new BrowserWorkerError("BROWSER_DESKTOP_UNAVAILABLE", 503);
    return { id, x: values.X!, y: values.Y!, width: values.WIDTH, height: values.HEIGHT };
  }
  private async captureDesktop(input: Input): Promise<Buffer> {
    const raw = await this.runProgram("xwd", ["-root", "-silent"], undefined, String(input.operationId), 1_280 * 800 * 4 + 65_536);
    this.assertAccess(input.expectedEpoch, input.actor); this.assertOperation(input);
    // FFmpeg's XWD reader needs a seekable input. Keep the bounded raw frame in
    // this container only, with exclusive mode 0600, and delete it on every exit.
    const path = join(tmpdir(), `aevoren-frame-${randomUUID()}.xwd`);
    try {
      const file = await open(path, "wx", 0o600);
      try { await file.writeFile(raw); } finally { await file.close(); }
      this.assertAccess(input.expectedEpoch, input.actor); this.assertOperation(input);
      return await this.runProgram("ffmpeg", ["-hide_banner", "-loglevel", "error", "-filter_threads", "1", "-f", "xwd_pipe", "-i", path, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-threads", "1", "-q:v", "4", "pipe:1"], undefined, String(input.operationId));
    } finally { await rm(path, { force: true }); }
  }

  private async windows(): Promise<DesktopWindow[]> {
    const ids = (await this.runProgram("xdotool", ["search", "--onlyvisible", "--class", "."])).toString().trim().split(/\s+/).filter(id => /^\d+$/.test(id)).slice(0, 100);
    const windows = await Promise.all(ids.map(async id => {
      try { return { ...await this.desktopWindow(id), title: (await this.runProgram("xdotool", ["getwindowname", id])).toString().trim().slice(0, 500) }; }
      catch { return null; }
    }));
    return windows.filter(window => window !== null);
  }

  private async desktopProof(input: Input): Promise<void> {
    this.assertAccess(input.expectedEpoch, input.actor); this.assertOperation(input);
    const proof = this.desktopObservations.get(input.observationId ?? "");
    if (!proof || proof.actor !== input.actor || proof.epoch !== input.expectedEpoch || this.control.needsObservation && input.actor === "ai"
      || input.pageId !== undefined && input.pageId !== proof.pageId
      || input.documentVersion !== undefined && input.documentVersion !== proof.documentVersion) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
    if (proof.pageId && (this.pages.get(proof.pageId)?.version !== proof.documentVersion || (await this.focusedPage())?.id !== proof.pageId)) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
    if (JSON.stringify(await this.desktopWindow()) !== JSON.stringify(proof.window)) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
    this.assertAccess(input.expectedEpoch, input.actor); this.assertOperation(input);
  }

  private async frame(input: Input, desktop: boolean): Promise<BrowserWorkerFrame> {
    const record = desktop && !input.pageId ? await this.focusedPage() : this.page(input.pageId);
    const version = record?.version, startedAt = Date.now();
    let phase = "focus-before";
    try {
    if (input.actor === "ai" && record && (!desktop || input.pageId)) {
      await record.page.bringToFront(); this.activePageId = record.id;
      await this.awaitFrameFocus(record, input, version!, Date.now() + 5_000);
    }
    this.assertAccess(input.expectedEpoch, input.actor); this.assertOperation(input);
    phase = "document-version-before";
    const observation = record && input.actor === "ai" ? await this.observe(record, input.expectedEpoch, 0, 18_000, "ai")
      : { id: randomUUID(), documentVersion: record?.version ?? null };
    const window = desktop ? await this.desktopWindow() : undefined;
    phase = "capture";
    const bytes = desktop
      ? await this.captureDesktop(input)
      : await record!.page.screenshot({ type: "jpeg", quality: 80, caret: "initial", timeout: 5_000 });
    this.assertAccess(input.expectedEpoch, input.actor); this.assertOperation(input);
    if (bytes.length > BROWSER_FRAME_MAX_BYTES) throw new BrowserWorkerError("BROWSER_IMAGE_TOO_LARGE", 413);
    phase = "focus-after";
    if (desktop && record && (await this.focusedPage())?.id !== record.id || window && JSON.stringify(await this.desktopWindow()) !== JSON.stringify(window)) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
    phase = "document-version-after";
    if (record && record.version !== observation.documentVersion) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
    if (window) {
      this.desktopObservations.set(observation.id, { epoch: input.expectedEpoch, actor: input.actor, window, pageId: record?.id ?? null, documentVersion: record?.version ?? null });
      while (this.desktopObservations.size > 20) this.desktopObservations.delete(this.desktopObservations.keys().next().value!);
    }
    if (input.actor === "ai") this.control.needsObservation = false;
    return { browserSessionId: this.options.browserSessionId, pageId: record?.id ?? null, observationId: observation.id, controlEpoch: input.expectedEpoch,
      documentVersion: record?.version ?? null, dataBase64: bytes.toString("base64"), mimeType: "image/jpeg", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      ...imageDimensions(bytes, "image/jpeg"), capturedAt: new Date().toISOString(), ...(window ? { desktop: window } : {}) };
    } catch (error) {
      if (process.env.AEVOREN_BROWSER_DIAGNOSTICS === "1" && error instanceof BrowserWorkerError && error.code === "BROWSER_OBSERVATION_STALE") {
        const safeVersion = (value: number | undefined): number | null => Number.isSafeInteger(value) && value! >= 0 ? value! : null;
        await writeFile("/tmp/aevoren-frame-diagnostics.json", JSON.stringify({ phase, desktop, ai: input.actor === "ai", elapsedMs: Math.min(60_000, Math.max(0, Date.now() - startedAt)),
          expectedEpoch: safeVersion(input.expectedEpoch), currentEpoch: safeVersion(this.control.epoch), ownerIsAi: this.control.owner === "ai", needsObservation: this.control.needsObservation,
          pageKnown: Boolean(record && this.pages.get(record.id) === record), pageClosed: record?.page.isClosed() ?? true, pageCount: Math.min(this.pages.size, 20),
          versionBefore: safeVersion(version), versionAfter: safeVersion(record?.version), focusChecks: this.lastFocusCheck }), { mode: 0o600 }).catch(() => undefined);
      }
      throw error;
    }
  }

  async perform(action: EngineAction, payload: Record<string, unknown> | ControlRecord): Promise<unknown> {
    if (action === "control") {
      this.control = { ...(payload as ControlRecord) };
      this.desktopObservations.clear();
      for (const waiter of this.focusWaiters) waiter.cancel();
      for (const pageId of this.pages.keys()) this.invalidate(pageId);
      await this.downloads?.controlChanged();
      const closing: Promise<void>[] = [];
      for (const operation of this.operations.values()) {
        if (!operation.running) continue;
        operation.cancelled = true;
        for (const child of operation.processes) child.kill("SIGKILL");
        if (operation.page) closing.push(operation.page.close().catch(() => undefined));
      }
      await Promise.allSettled(closing);
      await Promise.allSettled([...this.active]);
      await this.desktopInput.release();
      return null;
    }
    if (action === "shutdown") {
      this.desktopObservations.clear();
      await this.desktopInput.release();
      for (const waiter of this.focusWaiters) waiter.cancel();
      await this.downloads?.close();
      if (this.browser?.isConnected()) {
        const session = await this.browser.newBrowserCDPSession().catch(() => null);
        await session?.send("Browser.close").catch(() => undefined);
      }
      await this.chrome?.close();
      await this.context?.close().catch(() => undefined);
      return null;
    }
    if (action === "discard-download") {
      const id = z.string().uuid().parse((payload as Record<string, unknown>).id);
      await rm(join(this.options.downloadsDirectory, id), { force: true });
      return null;
    }
    if (action === "cancel") {
      const id = String((payload as Record<string, unknown>).operationId), operation = this.operations.get(id);
      if (operation) {
        operation.cancelled = true;
        for (const waiter of this.focusWaiters) if (String(waiter.operationId) === id) waiter.cancel();
        for (const child of operation.processes) child.kill("SIGKILL");
        await operation.page?.close().catch(() => undefined);
      } else {
        this.operations.set(id, { cancelled: true, running: false, page: null, processes: new Set() });
        for (const waiter of this.focusWaiters) if (String(waiter.operationId) === id) waiter.cancel();
      }
      return null;
    }
    const input = payload as Input;
    this.assertAccess(input.expectedEpoch, input.actor);
    this.assertOperation(input);
    if (input.operationId) this.operations.set(String(input.operationId), { cancelled: false, running: true, page: input.pageId && action !== "computer-action" ? this.page(input.pageId).page : null, processes: new Set() });
    const work = this.performAI(action, input);
    this.active.add(work);
    try { const result = await work; this.assertAccess(input.expectedEpoch, input.actor); this.assertOperation(input); return result; }
    finally { this.active.delete(work); const operation = this.operations.get(String(input.operationId)); if (operation) operation.running = false; }
  }

  private async performAI(action: EngineAction, input: Input): Promise<unknown> {
    if (action === "release-input") { await this.desktopInput.release(); return { released: true }; }
    if (action === "read-download") return { dataBase64: (await readDownload(this.options.downloadsDirectory, input.metadata as DownloadRecord)).toString("base64") };
    if (action === "windows") return this.windows();
    if (action === "pages") { await Promise.allSettled([...this.registering.values()]); return Promise.all([...this.pages.values()].map(value => this.pageDTO(value))); }
    if (action === "create") {
      await this.ensureBrowser();
      if (input.actor === "ai" && this.control.needsObservation) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
      if (this.pages.size >= 20) throw new BrowserWorkerError("BROWSER_PAGE_LIMIT", 409);
      const record = await this.register(await this.context!.newPage());
      const operation = this.operations.get(String(input.operationId));
      if (operation) operation.page = record.page;
      if (operation?.cancelled) { await record.page.close(); throw new BrowserWorkerError("BROWSER_OPERATION_CANCELLED", 409); }
      this.assertAccess(input.expectedEpoch, input.actor);
      const url = browserUrlSchema.parse(input.url ?? "about:blank");
      try { await record.page.goto(url, { waitUntil: "domcontentloaded" }); }
      catch { throw new BrowserWorkerError("BROWSER_NAVIGATION_FAILED", 502); }
      return this.pageDTO(record);
    }
    if (action === "frame" || action === "desktop-frame") return this.frame(input, action === "desktop-frame");
    if (action === "computer-action") {
      await this.desktopProof(input);
      this.desktopObservations.delete(input.observationId!);
      try {
        if (input.method === "focusWindow") {
          if (!(await this.windows()).some(window => window.id === input.windowId)) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
          this.assertAccess(input.expectedEpoch, input.actor); this.assertOperation(input);
          await this.runProgram("xdotool", ["windowactivate", "--sync", String(input.windowId)], undefined, String(input.operationId));
        } else await this.desktopInput.perform(input, () => { this.assertAccess(input.expectedEpoch, input.actor); this.assertOperation(input); },
          async (args, text) => this.runProgram("xdotool", args, text, String(input.operationId)));
      } catch (error) { await this.desktopInput.release(); throw error; }
      const record = input.pageId ? this.pages.get(input.pageId) : undefined;
      if (record) { record.version++; this.invalidate(record.id); return this.pageDTO(record); }
      return { desktop: await this.desktopWindow(), updatedAt: new Date().toISOString() };
    }
    const record = this.page(input.pageId);
    if (action === "observe") return this.observe(record, input.expectedEpoch, Number(input.offset ?? 0), Number(input.maxCharacters ?? 18_000), input.actor);
    if (action === "navigate" || action === "close-page") {
      if (input.actor === "ai" && this.control.needsObservation) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
      this.assertOperation(input);
      if (action === "navigate") {
        const url = browserUrlSchema.parse(input.url);
        try { await record.page.goto(url, { waitUntil: "domcontentloaded" }); }
        catch { throw new BrowserWorkerError("BROWSER_NAVIGATION_FAILED", 502); }
        return this.pageDTO(record);
      }
      await record.page.close(); return { pageId: record.id, closed: true };
    }
    this.proof(input);
    {
      await record.page.bringToFront(); this.activePageId = record.id;
      const proof = this.proof(input);
      if (input.method === "click" || input.method === "type") {
        const target = proof.observation.refs.get(String(input.ref));
        if (!target || !proof.observation.fingerprints?.get(String(input.ref)) || await targetFingerprint(target) !== proof.observation.fingerprints.get(String(input.ref))) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
        this.proof(input);
        if (input.method === "click") await target.click({ button: (input.button ?? "left") as "left" | "middle" | "right", timeout: 5_000 });
        else if (input.replace) await target.fill(String(input.text), { timeout: 5_000 });
        else await target.type(String(input.text), { timeout: 5_000 });
      } else if (input.method === "key") {
        const focused = proof.observation.focused;
        if (!focused || !await focused.evaluate(node => node === node.ownerDocument?.activeElement).catch(() => false)
          || await targetFingerprint(focused, true) !== proof.observation.focusFingerprint) throw new BrowserWorkerError("BROWSER_OBSERVATION_STALE", 409);
        this.proof(input); await record.page.keyboard.press(String(input.key));
      }
      else if (input.method === "scroll") { this.assertAccess(input.expectedEpoch, input.actor); await record.page.mouse.wheel(Number(input.deltaX), Number(input.deltaY)); }
      else throw new BrowserWorkerError("BROWSER_INVALID_REQUEST");
    }
    this.assertAccess(input.expectedEpoch, input.actor);
    record.version++; this.invalidate(record.id);
    return this.pageDTO(record);
  }
}

export async function runEngine(): Promise<void> {
  const engine = new BrowserEngine({ browserSessionId: process.argv[2]!, profileDirectory: process.argv[3]!, downloadsDirectory: process.argv[4]! });
  await engine.initialize();
  process.on("message", value => {
    const request = value as EngineRequest;
    if (request.type !== "request") return;
    void engine.perform(request.action, request.payload).then(result => {
      send({ type: "response", id: request.id, ok: true, value: result });
    }, error => {
      send({ type: "response", id: request.id, ok: false, code: error instanceof BrowserWorkerError ? error.code : "BROWSER_OPERATION_FAILED", status: error instanceof BrowserWorkerError ? error.status : 502 });
    });
  });
  process.once("disconnect", () => { void engine.perform("shutdown", {}).finally(() => process.exit(0)); });
  send({ type: "ready" });
}
