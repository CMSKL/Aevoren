import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRepository } from "./database";
import { BrowserService } from "./browser-service";
import { BrowserDockerDriver, DockerMemoryError } from "./browser-docker-driver";
import { DockerDriver } from "./docker-driver";
import { EnvironmentService } from "./environment-service";
import { ExecutionWorkerClient } from "./execution-worker-client";
import { AevorenBotError } from "./errors";
import type { BrowserPage, BrowserScope, BrowserSession, BrowserWorkerControl } from "@shared/browser-contracts";
import { BROWSER_WORKER_VERSION } from "@shared/browser-contracts";
import { ENV_WORKER_VERSION } from "@shared/environment-contracts";

type Fixture = { repository: AppRepository; service: BrowserService; environments: EnvironmentService; driver: BrowserDockerDriver; scope: BrowserScope; browser: BrowserSession; page: BrowserPage; control: BrowserWorkerControl;
  calls: Array<{ path: string; body: Record<string, unknown> }>; changed: ReturnType<typeof vi.fn>; root: string; server: Server; executionServers?: Server[]; readonly inputCount: number; holdFrame(fn: () => Promise<void>): void; setFramePage(page: BrowserPage | null): void; holdHealth(fn?: () => Promise<void>): void; stopWorker(code?: string): void; restartWorker(reset?: boolean): void };
const fixtures: Fixture[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6iFAAAAAASUVORK5CYII=", "base64");
async function fixture(browserWorkerVersion = "1.0.0"): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "aevoren-browser-host-boundary-")), repository = new AppRepository(join(root, "app.sqlite"));
  const actor = repository.createBot(), scope = { sessionId: actor.session.id, executorBotId: actor.bot.id };
  const env = repository.environments.ensure(scope, { workerVersion: ENV_WORKER_VERSION, imageRef: "fixture", imageDigest: `sha256:${"a".repeat(64)}`, platform: "linux/arm64" });
  repository.environments.update(scope, env.version, { state: "running" });
  const browser = repository.browsers.ensure(scope, { environmentId: env.id });
  let bootId = randomUUID(), workerAvailable = true, workerFailure = "BROWSER_UNAVAILABLE";
  let holdHealth: (() => Promise<void>) | undefined;
  const token = "b".repeat(64), control = { owner: "ai" as "ai" | "user", controlEpoch: 1, observedEpoch: null as number | null, connectionState: "disconnected" as const };
  const now = new Date().toISOString();
  const page = { id: randomUUID(), browserSessionId: browser.id, url: "https://fixture.test", title: "Transport fixture", documentVersion: 1, createdAt: now, updatedAt: now };
  const extraPages: BrowserPage[] = [];
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [], completed = new Map<string, unknown>();
  let inputCount = 0, timestamps = 0;
  let framePage: BrowserPage | null = page;
  let holdFrame: (() => Promise<void>) | undefined;
  const server = createServer(async (request, response) => {
    expect(request.headers.authorization).toBe(`Bearer ${token}`);
    const path = request.url!.split("?")[0]!;
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
    calls.push({ path, body }); response.setHeader("content-type", "application/json");
    const answer = (value: unknown): void => { response.end(JSON.stringify(value)); };
    if (path === "/v1/health") {
      const available = workerAvailable, code = workerFailure;
      const health = { environmentId: env.id, browserSessionId: browser.id, bootId, protocolVersion: 1, workerVersion: browserWorkerVersion, capabilities: ["browser", "images"], control: { ...control } };
      await holdHealth?.();
      if (!available) { response.statusCode = 503; answer({ error: { code } }); return; }
      answer(health); return;
    }
    if (!workerAvailable) { response.statusCode = 503; answer({ error: { code: workerFailure } }); return; }
    if (path === "/v1/browser/pages") {
      if (request.method === "POST") { const created = { ...page, id: randomUUID(), url: String(body.url), createdAt: new Date().toISOString() }; extraPages.push(created); answer(created); }
      else answer([{ ...page, updatedAt: new Date(Date.now() + ++timestamps).toISOString() }, ...extraPages]);
      return;
    }
    if (path === "/v1/computer/takeover" || path === "/v1/computer/return") { control.owner = path.endsWith("return") ? "ai" : "user"; control.controlEpoch++; control.observedEpoch = null; answer(control); return; }
    if (path === "/v1/computer/screenshot") {
      await holdFrame?.();
      answer({ browserSessionId: browser.id, pageId: framePage?.id ?? null, observationId: randomUUID(), controlEpoch: body.expectedEpoch, documentVersion: framePage?.documentVersion ?? null,
        dataBase64: png.toString("base64"), mimeType: "image/png", size: png.length, sha256: createHash("sha256").update(png).digest("hex"), width: 1, height: 1, capturedAt: now }); return;
    }
    if (path.endsWith("/click")) {
      const id = String(body.operationId); if (completed.has(id)) { answer(completed.get(id)); return; }
      if (body.documentVersion !== page.documentVersion) { response.writeHead(409); answer({ error: { code: "BROWSER_OBSERVATION_STALE" } }); return; }
      inputCount++; page.documentVersion++; const result = { ...page }; completed.set(id, result); answer(result); return;
    }
    response.writeHead(404); answer({ error: { code: "BROWSER_ROUTE_NOT_FOUND" } });
  });
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture bind failed");
  repository.browsers.updateConnection(scope, { encryptedToken: token, workerPort: address.port, containerId: "fixture-container", workerVersion: browserWorkerVersion, imageDigest: `sha256:${"c".repeat(64)}` });
  repository.browsers.syncControl(scope, control, bootId); repository.browsers.update(scope, repository.browsers.get(scope)!.version, { state: "running" });
  repository.browsers.upsertPage(scope, page, 1); repository.browsers.update(scope, repository.browsers.get(scope)!.version, { activePageId: page.id });
  const codec = { isAvailable: () => true, encrypt: (value: string) => value, decrypt: (value: string) => value }, driver = new BrowserDockerDriver(), changed = vi.fn();
  vi.spyOn(driver, "reserveComputer").mockResolvedValue(async () => {});
  vi.spyOn(driver, "inspectBrowser").mockResolvedValue({ id: "fixture-container", name: "fixture", imageId: `sha256:${"c".repeat(64)}`, state: "running", workerPort: address.port, oomKilled: false });
  const environments = new EnvironmentService(repository.environments, codec, root, () => undefined,
    new DockerDriver(async () => { throw new Error("The controlled HTTP fixture must not use real Docker"); }));
  vi.spyOn(environments, "get").mockImplementation(async input => repository.environments.get(input));
  vi.spyOn(environments, "pauseAutomation").mockResolvedValue();
  vi.spyOn(environments, "reconcileBinding").mockResolvedValue(repository.environments.get(scope)!);
  vi.spyOn(environments, "probe").mockResolvedValue({ available: true, dockerInstalled: true, daemonReachable: true, serverVersion: "fixture", platform: "linux/arm64", workerImagePresent: true, reason: null });
  const service = new BrowserService(repository, codec, root, join(root, "media"), environments, changed, driver);
  const value = { repository, service, environments, driver, scope, browser, page, control, calls, changed, root, server, get inputCount() { return inputCount; }, holdFrame(fn: () => Promise<void>) { holdFrame = fn; }, setFramePage(value: BrowserPage | null) { framePage = value; }, holdHealth(fn?: () => Promise<void>) { holdHealth = fn; }, stopWorker(code = "BROWSER_UNAVAILABLE") { workerAvailable = false; workerFailure = code; }, restartWorker(reset = false) { workerAvailable = true; bootId = randomUUID(); control.controlEpoch = reset ? 1 : control.controlEpoch + 1; if (reset) { control.owner = "ai"; control.observedEpoch = null; } } };
  fixtures.push(value); return value;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.service.shutdown(); for (const server of [f.server, ...f.executionServers ?? []]) { server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())); } f.repository.close(); rmSync(f.root, { recursive: true, force: true }); }
  vi.restoreAllMocks();
});

async function executionTransport(f: Fixture) {
  const environment = f.repository.environments.get(f.scope)!, bootId = randomUUID(), token = "a".repeat(64);
  let port = 0, state = "running", gate: (() => Promise<void>) | undefined;
  const listen = async () => {
    const server = createServer(async (request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`); response.setHeader("content-type", "application/json");
      if (request.url === "/v1/health") { await gate?.(); response.end(JSON.stringify({ environmentId: environment.id, bootId, protocolVersion: 1, workerVersion: ENV_WORKER_VERSION, capabilities: ["execution", "files"] })); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString()) as { path: string; content: string };
      response.end(JSON.stringify({ path: input.path, size: Buffer.byteLength(input.content), sha256: createHash("sha256").update(input.content).digest("hex") }));
    });
    await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
    port = (server.address() as { port: number }).port; (f.executionServers ??= []).push(server); return server;
  };
  const server = await listen();
  f.repository.environments.update(f.scope, environment.version, { containerId: "fixture-execution", encryptedToken: token, workerPort: port, bootId });
  const runner = vi.fn(async (args: string[]) => {
    if (args.join(" ") === "context show") return { stdout: "fixture-local", stderr: "" };
    if (args[0] === "context") return { stdout: JSON.stringify("unix:///fixture-docker.sock"), stderr: "" };
    if (args.includes("stop")) { state = "exited"; return { stdout: "", stderr: "" }; }
    expect(args).toContain(`aevoren-execution-${environment.id}`);
    return { stdout: JSON.stringify({ Id: "fixture-execution", Image: environment.imageDigest,
      Config: { Labels: { "io.aevoren.role": "execution-environment", "io.aevoren.environment": environment.id } },
      State: { Status: state, OOMKilled: false }, HostConfig: { ReadonlyRootfs: true, CapDrop: ["ALL"] },
      Mounts: [{ Type: "volume", Name: `aevoren-work-${environment.id}`, Destination: "/workspace" }, { Type: "volume", Name: `aevoren-state-${environment.id}`, Destination: "/var/lib/aevoren" }],
      NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }] } } }), stderr: "" };
  });
  const codec = { isAvailable: () => true, encrypt: (value: string) => value, decrypt: (value: string) => value };
  const environments = new EnvironmentService(f.repository.environments, codec, f.root, () => undefined, new DockerDriver(runner));
  vi.spyOn(environments, "probe").mockResolvedValue({ available: true, dockerInstalled: true, daemonReachable: true, serverVersion: "fixture", platform: "linux/arm64", workerImagePresent: true, reason: null });
  const service = new BrowserService(f.repository, codec, f.root, join(f.root, "media"), environments, () => undefined, f.driver);
  return { environments, service, server, listen, runner, token, environmentId: environment.id, get port() { return port; }, holdHealth(fn: () => Promise<void>) { gate = fn; } };
}

describe("host browser permission and pixel transport boundaries (controlled HTTP, not Chromium execution)", () => {
  it("recovers the same stopped desktop for an explicit human return without losing its control epoch", async () => {
    const f = await fixture();
    const view = await f.service.takeover({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 1 });
    f.repository.browsers.update(f.scope, f.repository.browsers.get(f.scope)!.version, { state: "stopped" });
    f.stopWorker();
    const container = (await f.driver.inspectBrowser(f.browser.id, f.repository.environments.get(f.scope)!.id))!;
    vi.mocked(f.driver.inspectBrowser).mockResolvedValue({ ...container, state: "exited" });
    const restart = vi.spyOn(f.driver, "startBrowser").mockImplementation(async () => { f.restartWorker(); return container; });
    await expect(f.service.returnControl({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: view.epoch })).resolves.toMatchObject({ owner: "ai" });
    expect(restart).toHaveBeenCalledOnce();
    expect(f.repository.browsers.get(f.scope)).toMatchObject({ state: "running" });
    expect(f.repository.browsers.view(f.scope)).toMatchObject({ owner: "ai" });
    expect(f.repository.browsers.view(f.scope)!.epoch).toBeGreaterThan(view.epoch + 1);
    expect(f.repository.browsers.view(f.scope)!.observedEpoch).toBeNull();
  });

  it.each(["foreign-image", "paused", "inspection-failed"])("keeps human ownership when stopped-desktop recovery is %s", async reason => {
    const f = await fixture();
    const view = await f.service.takeover({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 1 });
    f.repository.browsers.update(f.scope, f.repository.browsers.get(f.scope)!.version, { state: "stopped" });
    const container = (await f.driver.inspectBrowser(f.browser.id, f.repository.environments.get(f.scope)!.id))!;
    if (reason === "inspection-failed") vi.mocked(f.driver.inspectBrowser).mockRejectedValue(new Error("Docker unavailable"));
    else vi.mocked(f.driver.inspectBrowser).mockResolvedValue({ ...container, state: reason === "paused" ? "paused" : "exited", ...(reason === "foreign-image" ? { imageId: `sha256:${"d".repeat(64)}` } : {}) });
    const restart = vi.spyOn(f.driver, "startBrowser");
    vi.mocked(f.environments.pauseAutomation).mockClear();
    await expect(f.service.returnControl({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: view.epoch })).rejects.toBeInstanceOf(AevorenBotError);
    expect(restart).not.toHaveBeenCalled();
    expect(f.repository.browsers.view(f.scope)?.owner).toBe("user");
    expect(f.environments.pauseAutomation).not.toHaveBeenCalled();
  });

  it("rejects an AI return or a stale human epoch before recovering a stopped desktop", async () => {
    const f = await fixture();
    const view = await f.service.takeover({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 1 });
    f.repository.browsers.update(f.scope, f.repository.browsers.get(f.scope)!.version, { state: "stopped" });
    const restart = vi.spyOn(f.driver, "startBrowser");
    await expect(f.service.returnControl({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: view.epoch }, { actor: "ai" })).rejects.toMatchObject({ code: "COMPUTER_USER_CONTROLLED" });
    await expect(f.service.returnControl({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: view.epoch - 1 })).rejects.toMatchObject({ code: "COMPUTER_CONTROL_CHANGED" });
    expect(restart).not.toHaveBeenCalled();
    expect(f.repository.browsers.view(f.scope)?.owner).toBe("user");
  });

  it("rechecks takeover after acquiring the lifecycle lock before an AI stop", async () => {
    const f = await fixture(), stop = vi.spyOn(f.driver, "stopBrowser").mockResolvedValue();
    const pending = f.service.stop({ ...f.scope, clientNonce: randomUUID() }, { actor: "ai" });
    f.repository.browsers.claimControl(f.scope, { owner: "user", expectedEpoch: 1 });
    await expect(pending).rejects.toMatchObject({ code: "COMPUTER_USER_CONTROLLED" });
    expect(stop).not.toHaveBeenCalled();
    expect(f.repository.browsers.get(f.scope)?.state).toBe("running");
  });
  it("seals AI access and freezes commands before admitting human desktop input", async () => {
    const f = await fixture(); let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const pause = vi.spyOn(f.environments, "pauseAutomation").mockImplementation(async (_scope, owner) => { if (owner) await paused; });
    const settled = vi.fn(async () => {}); f.service.setControlLifecycle(settled);
    const pending = f.service.takeover({ ...f.scope, expectedEpoch: 1, clientNonce: randomUUID() });
    await expect.poll(() => pause.mock.calls.length).toBe(1);
    expect(f.repository.browsers.view(f.scope)?.owner).toBe("user");
    expect(f.calls.some(call => call.path === "/v1/computer/takeover")).toBe(false);
    await expect(f.service.computerScreenshot({ ...f.scope, expectedEpoch: 2 }, { actor: "ai" })).rejects.toMatchObject({ code: "COMPUTER_USER_CONTROLLED" });
    release(); await expect(pending).resolves.toMatchObject({ owner: "user" });
    expect(settled).toHaveBeenCalledWith(f.scope, "user");
  });
  it("stores actual bytes, gates the ephemeral image immediately on takeover and requires fresh AI input after return", async () => {
    const f = await fixture();
    const shot = await f.service.computerScreenshot({ ...f.scope, expectedEpoch: 1 }, { actor: "ai" });
    const attachment = await f.service.imageAttachment(f.scope, shot.media.id, 1);
    expect(Buffer.from(attachment.dataBase64, "base64")).toEqual(png); expect(attachment.isAuthorized()).toBe(true);
    const user = await f.service.takeover({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 1 });
    expect(user).toMatchObject({ owner: "user", epoch: 2 }); expect(attachment.isAuthorized()).toBe(false);
    const count = f.calls.length;
    await expect(f.service.computerScreenshot({ ...f.scope, expectedEpoch: 2 }, { actor: "ai" })).rejects.toMatchObject({ code: "COMPUTER_USER_CONTROLLED" });
    expect(f.calls).toHaveLength(count);
    const returned = await f.service.returnControl({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 2 });
    expect(returned).toMatchObject({ owner: "ai", epoch: 3, observedEpoch: null });
    await f.service.computerScreenshot({ ...f.scope, expectedEpoch: 3 });
    expect(f.repository.browsers.view(f.scope)?.observedEpoch).toBeNull();
    await expect(f.service.navigate({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 3, pageId: f.page.id, url: "https://fixture.test/changed" }, { actor: "ai" })).rejects.toMatchObject({ code: "BROWSER_OBSERVATION_REQUIRED" });
    await expect(f.service.takeover({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 3 }, { actor: "ai" })).rejects.toMatchObject({ code: "COMPUTER_USER_CONTROLLED" });
  });
  it("refreezes commands when return-to-AI binding verification fails, retaining human ownership", async () => {
    const f = await fixture(), pause = vi.spyOn(f.environments, "pauseAutomation").mockResolvedValue();
    const lifecycle = vi.fn(async () => {}); f.service.setControlLifecycle(lifecycle);
    await f.service.takeover({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 1 });
    pause.mockClear(); lifecycle.mockClear();
    vi.mocked(f.environments.reconcileBinding).mockRejectedValue(new AevorenBotError("ENVIRONMENT_UNAVAILABLE"));
    await expect(f.service.returnControl({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 2 })).rejects.toMatchObject({ code: "ENVIRONMENT_UNAVAILABLE" });
    expect(pause.mock.calls.map(call => call[1])).toEqual([false, true]);
    expect(f.repository.browsers.view(f.scope)?.owner).toBe("user");
    expect(f.repository.browsers.get(f.scope)?.state).toBe("unknown");
    expect(lifecycle).not.toHaveBeenCalled();
  });
  it("blocks a late screenshot return after takeover without publishing its media", async () => {
    const f = await fixture(); let ready!: () => void, release!: () => void;
    const entered = new Promise<void>(accept => { ready = accept; }), blocked = new Promise<void>(accept => { release = accept; });
    f.holdFrame(async () => { ready(); await blocked; });
    const pending = f.service.computerScreenshot({ ...f.scope, expectedEpoch: 1 }, { actor: "ai" }).catch(error => error as Error);
    await entered; await f.service.takeover({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 1 }); release();
    expect(await pending).toMatchObject({ code: "COMPUTER_CONTROL_CHANGED" });
  });
  it("reuses a completed nonce when the document already changed, without a second input", async () => {
    const f = await fixture(), shot = await f.service.computerScreenshot({ ...f.scope, expectedEpoch: 1 }, { actor: "ai" });
    const input = { ...f.scope, clientNonce: randomUUID(), expectedEpoch: 1, pageId: f.page.id, observationId: shot.frame.observationId, documentVersion: 1, ref: "element_fixture" };
    const first = await f.service.click(input, { actor: "ai" }), repeated = await f.service.click(input, { actor: "ai" });
    expect(repeated).toEqual(first); expect(f.inputCount).toBe(1);
    await expect(f.service.click({ ...input, clientNonce: randomUUID() }, { actor: "ai" })).rejects.toMatchObject({ code: "BROWSER_OBSERVATION_REQUIRED" });
    expect(f.calls.filter(call => call.path.endsWith("/click")).every(call => !["clientNonce", "sessionId", "executorBotId", "runtimeRunId"].some(key => key in call.body))).toBe(true);
  });
  it("reports insufficient Docker capacity before starting the companion environment", async () => {
    const f = await fixture();
    const environment = f.repository.environments.get(f.scope)!;
    f.repository.environments.update(f.scope, environment.version, { state: "stopped" });
    vi.mocked(f.driver.reserveComputer).mockRejectedValueOnce(new DockerMemoryError(2304, 700));
    const start = vi.spyOn(f.environments, "start");
    await expect(f.service.start({ ...f.scope, clientNonce: randomUUID() })).rejects.toMatchObject({ code: "COMPUTER_MEMORY_INSUFFICIENT", details: { requiredMiB: 2304, availableMiB: 700 } });
    expect(start).not.toHaveBeenCalled();
    expect(f.service.startupStatus(f.scope)).toMatchObject({ phase: "error", blocker: "startup-failed" });
    expect(f.service.startupStatus(f.scope)?.message).toContain("2304 MiB");
  });
  it("does not increment versions or emit feedback events for repeated healthy getters and UI frames", async () => {
    const f = await fixture(), before = f.repository.browsers.get(f.scope)!.version;
    await f.service.get(f.scope); await f.service.get(f.scope);
    await f.service.computerScreenshot({ ...f.scope, expectedEpoch: 1 }); await f.service.computerScreenshot({ ...f.scope, expectedEpoch: 1 });
    expect(f.repository.browsers.get(f.scope)!.version).toBe(before); expect(f.changed).not.toHaveBeenCalled();
  });
  it("returns already-running metadata to AI without disturbing human ownership or requesting private pages", async () => {
    const f = await fixture(); await f.service.takeover({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 1 });
    vi.spyOn(f.environments, "reconcileBinding").mockResolvedValue(f.repository.environments.get(f.scope)!);
    const before = f.repository.browsers.get(f.scope), pages = f.calls.filter(call => call.path === "/v1/browser/pages").length;
    expect(await f.service.start({ ...f.scope, clientNonce: randomUUID() }, { actor: "ai" })).toEqual(before);
    expect(f.repository.browsers.view(f.scope)).toMatchObject({ owner: "user", epoch: 2 });
    expect(f.calls.filter(call => call.path === "/v1/browser/pages")).toHaveLength(pages);
    expect(f.repository.browsers.get(f.scope)?.state).toBe("running");
  });
  it("validates the desktop's actual scoped page rather than a stale UI-selected page id", async () => {
    const f = await fixture(), shot = await f.service.computerScreenshot({ ...f.scope, expectedEpoch: 1, pageId: randomUUID() });
    expect(shot.frame.pageId).toBe(f.page.id); expect(shot.media.pageId).toBe(f.page.id);
  });
  it("keeps a user's real unassociated desktop frame readable without creating an AI proof or image carrier", async () => {
    const f = await fixture(); f.setFramePage(null);
    const shot = await f.service.computerScreenshot({ ...f.scope, expectedEpoch: 1 });
    expect(shot.frame).toMatchObject({ pageId: null, documentVersion: null });
    expect(f.repository.browsers.assertFrame(f.scope, shot.media.id, 1, "user")).toMatchObject({ pageId: null });
    expect(f.repository.browsers.view(f.scope)?.observedEpoch).toBeNull();
    await expect(f.service.imageAttachment(f.scope, shot.media.id, 1)).rejects.toMatchObject({ code: "BROWSER_OBSERVATION_REQUIRED" });
    await expect(f.service.computerScreenshot({ ...f.scope, expectedEpoch: 1 }, { actor: "ai" })).rejects.toMatchObject({ code: "BROWSER_OBSERVATION_REQUIRED" });
  });
  it("reuses the same preview intent and capability without creating another page or metadata row", async () => {
    const f = await fixture(); await f.service.computerScreenshot({ ...f.scope, expectedEpoch: 1 }, { actor: "ai" });
    const session = f.repository.environments.createSession(f.scope, null), job = f.repository.environments.createExecution(f.scope,
      { executionSessionId: session.id, clientNonce: randomUUID(), kind: "background", command: "preview metadata fixture only" }).execution;
    f.repository.environments.updateExecution(f.scope, job.id, job.version, { state: "running" });
    const port = f.repository.environments.upsertPort(f.scope, { processId: job.id, port: 8123, state: "listening" });
    vi.spyOn(f.environments, "listPorts").mockResolvedValue([port]);
    vi.spyOn(f.environments, "createPreview").mockImplementation(async (_scope, id, registeredPortId) => ({ id, registeredPortId, processId: job.id, port: port.port,
      host: `${"a".repeat(32)}.${"b".repeat(32)}.aevoren-preview-${job.environmentId}.internal`, expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    const input = { ...f.scope, expectedEpoch: 1, clientNonce: randomUUID(), registeredPortId: port.id };
    const first = await f.service.previewOpen(input, { actor: "ai" }), repeated = await f.service.previewOpen(input, { actor: "ai" });
    expect(repeated).toEqual(first); expect(f.repository.browsers.listPreviews(f.scope, 1)).toHaveLength(1);
    expect(f.calls.filter(call => call.path === "/v1/browser/pages" && "operationId" in call.body)).toHaveLength(1);
  });
  it("retains pinned configuration on sleep but clears it after an explicit remove/rebuild", async () => {
    const f = await fixture(); vi.spyOn(f.driver, "stopBrowser").mockResolvedValue();
    const original = f.repository.browsers.getInternal(f.scope)!;
    await f.service.release(f.scope, false); expect(f.repository.browsers.getInternal(f.scope)?.imageDigest).toBe(original.imageDigest);
    await f.service.release(f.scope, true);
    expect(f.repository.browsers.getInternal(f.scope)).toMatchObject({ id: original.id, imageDigest: null, imageRef: null, workerVersion: null, platform: null, workerPort: null, containerId: null, encryptedToken: original.encryptedToken });
  });
  it("never replays an old successful return after a new takeover", async () => {
    const f = await fixture(); await f.service.takeover({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 1 });
    const previous = { ...f.scope, clientNonce: randomUUID(), expectedEpoch: 2 };
    await f.service.returnControl(previous); await f.service.takeover({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 3 });
    const count = f.calls.filter(call => call.path === "/v1/computer/return").length;
    await expect(f.service.returnControl(previous)).rejects.toMatchObject({ code: "COMPUTER_CONTROL_CHANGED" });
    expect(f.calls.filter(call => call.path === "/v1/computer/return")).toHaveLength(count);
    expect(f.repository.browsers.view(f.scope)).toMatchObject({ owner: "user", epoch: 4 });
  });
  it("never replays an old successful takeover after an explicit return", async () => {
    const f = await fixture(), previous = { ...f.scope, clientNonce: randomUUID(), expectedEpoch: 1 };
    await f.service.takeover(previous); await f.service.returnControl({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 2 });
    const count = f.calls.filter(call => call.path === "/v1/computer/takeover").length;
    await expect(f.service.takeover(previous)).rejects.toMatchObject({ code: "COMPUTER_CONTROL_CHANGED" });
    expect(f.calls.filter(call => call.path === "/v1/computer/takeover")).toHaveLength(count);
    expect(f.repository.browsers.view(f.scope)).toMatchObject({ owner: "ai", epoch: 3 });
  });
  it.each([true, false])("starts an AI-owned computer after a fresh Worker boot without lowering epochs (reset=%s)", async reset => {
    const f = await fixture(BROWSER_WORKER_VERSION);
    await f.service.takeover({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 1 });
    await f.service.returnControl({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 2 });
    const frame = await f.service.computerScreenshot({ ...f.scope, expectedEpoch: 3 });
    const attachment = await f.service.imageAttachment(f.scope, frame.media.id, 3);
    expect(attachment.isAuthorized()).toBe(true);
    const previousBoot = f.repository.browsers.get(f.scope)!.bootId;
    f.repository.browsers.update(f.scope, f.repository.browsers.get(f.scope)!.version, { state: "stopped" });
    f.restartWorker(reset);
    vi.spyOn(f.driver, "inspectBrowserImage").mockResolvedValue({ id: `sha256:${"c".repeat(64)}`, ref: "fixture", workerVersion: BROWSER_WORKER_VERSION, platform: "linux/arm64", bundleSha256: "d".repeat(64) });
    const returns = f.calls.filter(call => call.path === "/v1/computer/return").length;
    await expect(f.service.start({ ...f.scope, clientNonce: randomUUID() })).resolves.toMatchObject({ state: "running" });
    expect(f.repository.browsers.view(f.scope)).toMatchObject({ owner: "ai", epoch: 4, observedEpoch: null });
    expect(f.repository.browsers.get(f.scope)!.bootId).not.toBe(previousBoot);
    expect(f.calls.filter(call => call.path === "/v1/computer/return").length - returns).toBe(reset ? 3 : 0);
    expect(attachment.isAuthorized()).toBe(false);
    expect(f.inputCount).toBe(0);
    await expect(f.service.computerScreenshot({ ...f.scope, expectedEpoch: 3 })).rejects.toMatchObject({ code: "COMPUTER_CONTROL_CHANGED" });
    await expect(f.service.computerScreenshot({ ...f.scope, expectedEpoch: 4 })).resolves.toHaveProperty("frame.dataBase64");
  });
  it("keeps a saved human lease sealed when a fresh Worker reports AI ownership", async () => {
    const f = await fixture(BROWSER_WORKER_VERSION);
    await f.service.takeover({ ...f.scope, clientNonce: randomUUID(), expectedEpoch: 1 });
    f.repository.browsers.update(f.scope, f.repository.browsers.get(f.scope)!.version, { state: "stopped" });
    f.restartWorker(true);
    const calls = f.calls.length;
    await expect(f.service.start({ ...f.scope, clientNonce: randomUUID() }, { actor: "ai" })).rejects.toMatchObject({ code: "COMPUTER_USER_CONTROLLED" });
    expect(f.repository.browsers.view(f.scope)).toMatchObject({ owner: "user", epoch: 2 });
    expect(f.calls.slice(calls).some(call => call.path === "/v1/computer/return" || call.path === "/v1/computer/screenshot")).toBe(false);
  });
  it("reconciles a Docker-verified remapped execution port before browser start succeeds, preserving background records and nonce replay", async () => {
    const f = await fixture(BROWSER_WORKER_VERSION), transport = await executionTransport(f), oldPort = transport.port;
    await new ExecutionWorkerClient(oldPort, transport.token, transport.environmentId).health();
    const session = f.repository.environments.createSession(f.scope, null), nonce = randomUUID();
    const job = f.repository.environments.createExecution(f.scope, { executionSessionId: session.id, clientNonce: nonce, kind: "background", command: "background metadata fixture" }).execution;
    f.repository.environments.updateExecution(f.scope, job.id, job.version, { state: "running" });
    f.repository.environments.appendLogs(f.scope, job.id, [{ seq: 1, executionId: job.id, stream: "stdout", text: "original background log", at: new Date().toISOString() }]);
    const original = f.repository.environments.getExecution(f.scope, job.id), logs = f.repository.environments.logs(f.scope, job.id);
    f.repository.browsers.update(f.scope, f.repository.browsers.get(f.scope)!.version, { state: "stopped" });
    const owned = await f.driver.inspectBrowser(f.browser.id, transport.environmentId);
    let created = false;
    vi.mocked(f.driver.inspectBrowser).mockImplementation(async () => created ? owned : null);
    vi.spyOn(f.driver, "inspectBrowserImage").mockResolvedValue({ id: `sha256:${"c".repeat(64)}`, ref: "fixture", workerVersion: BROWSER_WORKER_VERSION, platform: "linux/arm64", bundleSha256: "d".repeat(64) });
    const create = vi.spyOn(f.driver, "createBrowser").mockImplementation(async () => {
      created = true;
      await transport.listen(); transport.server.closeAllConnections(); await new Promise<void>(accept => transport.server.close(() => accept()));
      return (await f.driver.inspectBrowser(f.browser.id, transport.environmentId))!;
    });
    const input = { ...f.scope, clientNonce: randomUUID() };
    expect((await transport.service.start(input)).state).toBe("running");
    expect(transport.port).not.toBe(oldPort);
    expect(f.repository.environments.getInternal(f.scope)?.workerPort).toBe(transport.port);
    await expect(new ExecutionWorkerClient(oldPort, transport.token, transport.environmentId).health()).rejects.toMatchObject({ code: "WORKER_CONNECTION_FAILED" });
    await expect(transport.environments.writeFile({ ...f.scope, path: "after-attachment.txt", content: "actual controlled HTTP bytes" })).resolves.toMatchObject({ path: "after-attachment.txt" });
    const version = f.repository.environments.get(f.scope)!.version;
    await transport.service.start(input); expect(create).toHaveBeenCalledTimes(1);
    expect(f.repository.environments.get(f.scope)!.version).toBe(version);
    expect(f.repository.environments.findExecutionByNonce(f.scope, nonce)).toEqual(original);
    expect(f.repository.environments.logs(f.scope, job.id)).toEqual(logs);
    expect(transport.runner.mock.calls.every(([args]) => !["run", "start", "stop", "rm"].some(operation => args.includes(operation)))).toBe(true);
  });
  it("does not restore a stopped environment when its older reconciliation health response arrives", async () => {
    const f = await fixture(), transport = await executionTransport(f);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(accept => { entered = accept; }), held = new Promise<void>(accept => { release = accept; });
    transport.holdHealth(async () => { entered(); await held; });
    const pending = transport.environments.reconcileBinding(f.scope).catch(error => error as Error);
    await waiting;
    try { await transport.environments.stop(f.scope); }
    finally { release(); }
    expect(await pending).toMatchObject({ code: "ENVIRONMENT_UNAVAILABLE" });
    expect(f.repository.environments.getInternal(f.scope)).toMatchObject({ state: "stopped", workerPort: null });
  });
});

describe("one-step computer preparation", () => {
  async function startupFixture() {
    const f = await fixture();
    vi.spyOn(f.environments, "probe").mockResolvedValue({ available: true, dockerInstalled: true, daemonReachable: true, serverVersion: "fixture", platform: "linux/arm64", workerImagePresent: false, reason: null });
    const owner = f.repository.createBot();
    return { ...f, cold: { sessionId: owner.session.id, executorBotId: owner.bot.id } };
  }
  it("prepares a cold computer before starting its environment, without a manual setup call", async () => {
    const f = await startupFixture(), order: string[] = [];
    const initialized = vi.spyOn(f.environments, "initialize").mockImplementation(async () => {
      order.push("prepare"); return { probe: await f.environments.probe(), imageRef: "fixture", imageDigest: `sha256:${"a".repeat(64)}`, workerVersion: "1.2.0" };
    });
    vi.spyOn(f.environments, "start").mockImplementation(async () => { order.push("start"); throw new Error("controlled environment startup failure"); });
    await expect(f.service.start({ ...f.cold, clientNonce: randomUUID() })).rejects.toBeDefined();
    expect(initialized).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["prepare", "start"]);
    expect(f.service.startupStatus(f.cold)).toMatchObject({ phase: "error", blocker: "startup-failed" });
  });
  it("allows environment lifecycle release during startup without a lock cycle or late launch", async () => {
    const f = await startupFixture();
    vi.spyOn(f.environments, "initialize").mockResolvedValue({ probe: await f.environments.probe(), imageRef: "fixture", imageDigest: `sha256:${"a".repeat(64)}`, workerVersion: "1.2.0" });
    vi.spyOn(f.environments, "start").mockImplementation(async () => {
      // Environment stop/rebuild owns its lock before releasing the companion.
      await f.service.release(f.cold);
      throw new Error("environment lifecycle interrupted startup");
    });
    const result = await f.service.start({ ...f.cold, clientNonce: randomUUID() }).catch(error => error);
    expect(result).toMatchObject({ code: "TOOL_EXECUTION_CANCELLED" });
    expect(f.repository.browsers.get(f.cold)).toBeNull();
  });
  it("reports a stopped Docker engine in place without preparing images or containers", async () => {
    const f = await startupFixture();
    vi.spyOn(f.environments, "probe").mockResolvedValue({ available: false, dockerInstalled: true, daemonReachable: false, serverVersion: null, platform: null, workerImagePresent: false, reason: "Docker 未就绪，请启动引擎后重新检测。" });
    const initialize = vi.spyOn(f.environments, "initialize"), start = vi.spyOn(f.environments, "start");
    await expect(f.service.start({ ...f.cold, clientNonce: randomUUID() })).rejects.toBeDefined();
    expect(f.service.startupStatus(f.cold)).toMatchObject({ phase: "error", blocker: "docker-stopped" });
    expect(initialize).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });
  it("cancels a pending cold start before any late environment creation", async () => {
    const f = await startupFixture(); let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const initialize = vi.spyOn(f.environments, "initialize").mockImplementation(async () => { await barrier; return { probe: await f.environments.probe(), imageRef: "fixture", imageDigest: `sha256:${"a".repeat(64)}`, workerVersion: "1.2.0" }; });
    const start = vi.spyOn(f.environments, "start");
    const pending = f.service.start({ ...f.cold, clientNonce: randomUUID() }).catch(error => error);
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledTimes(1));
    const status = f.service.startupStatus(f.cold)!;
    f.service.cancelStartup({ ...f.cold, attemptId: status.attemptId });
    expect(await pending).toMatchObject({ code: "TOOL_EXECUTION_CANCELLED" });
    release(); await barrier; await Promise.resolve();
    expect(start).not.toHaveBeenCalled(); expect(f.repository.environments.get(f.cold)).toBeNull();
    expect(f.service.startupStatus(f.cold)).toMatchObject({ phase: "cancelled" });
  });
  it("starts six scopes before the first preparation finishes and coalesces repeated opens", async () => {
    const f = await startupFixture(); let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const initialize = vi.spyOn(f.environments, "initialize").mockImplementation(async () => { await barrier; return { probe: await f.environments.probe(), imageRef: "fixture", imageDigest: `sha256:${"a".repeat(64)}`, workerVersion: "1.2.0" }; });
    const start = vi.spyOn(f.environments, "start").mockRejectedValue(new Error("controlled environment startup failure"));
    const owners = Array.from({ length: 6 }, () => f.repository.createBot());
    const room = f.repository.createRoom({ memberBotIds: owners.map(owner => owner.bot.id) });
    const inputs = owners.map(owner => ({ sessionId: room.session.id, executorBotId: owner.bot.id, clientNonce: randomUUID() }));
    const pending = inputs.map(input => f.service.start(input).catch(error => error));
    const repeated = f.service.start(inputs[0]!).catch(error => error);
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledTimes(6));
    f.service.cancelStartup({ sessionId: inputs[0]!.sessionId, executorBotId: inputs[0]!.executorBotId, attemptId: f.service.startupStatus(inputs[0]!)!.attemptId });
    expect(await pending[0]).toMatchObject({ code: "TOOL_EXECUTION_CANCELLED" });
    expect(await repeated).toMatchObject({ code: "TOOL_EXECUTION_CANCELLED" });
    expect(inputs.slice(1).every(input => f.service.startupStatus(input)?.phase === "preparing-environment")).toBe(true);
    release(); await Promise.all(pending);
    expect(start).toHaveBeenCalledTimes(5);
    expect(start.mock.calls.every(([input]) => input.executorBotId !== inputs[0]!.executorBotId)).toBe(true);
  });
});


describe("P2 reconciled computer health and startup truth", () => {
  async function ready() {
    const f = await fixture(); await f.service.start({ ...f.scope, clientNonce: randomUUID() });
    expect(f.service.startupStatus(f.scope)?.phase).toBe("ready"); return f;
  }
  it("revokes ready on confirmed engine failure and publishes only safe diagnostics", async () => {
    const f = await ready(); f.stopWorker("BROWSER_ENGINE_STOPPED");
    expect((await f.service.get(f.scope))?.state).toBe("error");
    expect(f.service.startupStatus(f.scope)).toMatchObject({ phase: "error", errorCode: "COMPUTER_DESKTOP_UNAVAILABLE", bootId: f.repository.browsers.get(f.scope)!.bootId });
    expect(f.service.startupStatus(f.scope)?.checkedAt).toMatch(/^\d{4}-/u);
    expect(JSON.stringify(f.service.startupStatus(f.scope))).not.toMatch(/Bearer|encryptedToken|stack|workerPort/u);
  });
  it("marks unavailable transport unknown rather than claiming a stopped engine", async () => {
    const f = await ready(); vi.mocked(f.driver.inspectBrowser).mockRejectedValue(new Error("controlled inspection failure"));
    expect((await f.service.get(f.scope))?.state).toBe("unknown");
    expect(f.service.startupStatus(f.scope)).toMatchObject({ phase: "error", errorCode: "BROWSER_UNAVAILABLE" });
  });
  it("records confirmed container stop without retaining a ready startup", async () => {
    const f = await ready(), container = (await f.driver.inspectBrowser(f.browser.id, f.repository.environments.get(f.scope)!.id))!;
    vi.mocked(f.driver.inspectBrowser).mockResolvedValue({ ...container, state: "exited" });
    expect((await f.service.get(f.scope))?.state).toBe("stopped");
    expect(f.service.startupStatus(f.scope)?.phase).not.toBe("ready");
  });
  it("revokes ready immediately when a screenshot reports engine failure", async () => {
    const f = await ready(); f.stopWorker("BROWSER_ENGINE_STOPPED");
    await expect(f.service.computerScreenshot({ ...f.scope, expectedEpoch: 1 }, { actor: "ai" })).rejects.toMatchObject({ code: "COMPUTER_DESKTOP_UNAVAILABLE" });
    expect(f.repository.browsers.get(f.scope)?.state).toBe("error");
    expect(f.service.startupStatus(f.scope)?.errorCode).toBe("COMPUTER_DESKTOP_UNAVAILABLE");
  });
  it("does not revive a stopped computer with a late successful health reply", async () => {
    const f = await ready(); let release!: () => void, observed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { observed = resolve; });
    f.holdHealth(async () => { observed(); await gate; });
    const pending = f.service.get(f.scope); await started;
    vi.spyOn(f.driver, "stopBrowser").mockResolvedValue();
    try { await f.service.stop({ ...f.scope, clientNonce: randomUUID() }); } finally { release(); }
    await pending; expect(f.repository.browsers.get(f.scope)?.state).toBe("stopped");
    expect(f.service.startupStatus(f.scope)?.phase).not.toBe("ready");
  });
  it("does not replace a fresh healthy boot with a late old failure", async () => {
    const f = await ready(); let release!: () => void, observed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { observed = resolve; });
    f.stopWorker("BROWSER_ENGINE_STOPPED"); f.holdHealth(async () => { observed(); await gate; });
    const pending = f.service.get(f.scope); await started;
    f.holdHealth(); f.restartWorker(); await f.service.get(f.scope); const bootId = f.repository.browsers.get(f.scope)!.bootId;
    release(); await pending;
    expect(f.repository.browsers.get(f.scope)).toMatchObject({ state: "running", bootId });
    expect(f.service.startupStatus(f.scope)).toMatchObject({ phase: "ready", bootId });
  });
  it("keeps takeover ownership and epoch when an older AI health reply arrives", async () => {
    const f = await ready(); let release!: () => void, observed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { observed = resolve; });
    f.holdHealth(async () => { observed(); await gate; });
    const pending = f.service.get(f.scope); await started;
    f.holdHealth(); const taken = await f.service.takeover({ ...f.scope, expectedEpoch: 1, clientNonce: randomUUID() }); release(); await pending;
    expect(f.repository.browsers.view(f.scope)).toMatchObject({ owner: "user", epoch: taken.epoch });
  });
  it("does not turn query cancellation into an engine fault", async () => {
    const f = await ready(); let release!: () => void, observed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { observed = resolve; });
    f.holdHealth(async () => { observed(); await gate; });
    const controller = new AbortController(), pending = f.service.get(f.scope, { signal: controller.signal }); await started;
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" }); controller.abort();
    try { await rejected; } finally { release(); }
    expect(f.repository.browsers.get(f.scope)?.state).toBe("running"); expect(f.service.startupStatus(f.scope)?.phase).toBe("ready");
  });
  it("keeps repeated healthy getters free of version and event churn", async () => {
    const f = await ready(); await f.service.get(f.scope); const version = f.repository.browsers.get(f.scope)!.version; f.changed.mockClear();
    await f.service.get(f.scope); await f.service.get(f.scope);
    expect(f.repository.browsers.get(f.scope)!.version).toBe(version); expect(f.changed).not.toHaveBeenCalled();
  });
});

it("does not diagnose an unavailable window as a stopped computer engine", async () => {
  const f = await fixture(); await f.service.start({ ...f.scope, clientNonce: randomUUID() }); f.stopWorker("BROWSER_DESKTOP_UNAVAILABLE");
  await expect(f.service.computerWindows({ ...f.scope, expectedEpoch: 1 }, { actor: "ai" })).rejects.toMatchObject({ code: "COMPUTER_DESKTOP_UNAVAILABLE" });
  expect(f.repository.browsers.get(f.scope)?.state).toBe("running"); expect(f.service.startupStatus(f.scope)?.phase).toBe("ready");
});
