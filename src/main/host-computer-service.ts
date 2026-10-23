import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { BrowserScope } from "@shared/browser-contracts";
import type { ComputerTarget, HostComputerConfiguration, HostComputerStatus } from "@shared/host-computer-contracts";
import type { HostAppTarget, HostComputerTarget, HostInputContext, HostCapture } from "@shared/host-computer-targets";
import type { ComputerTask } from "@shared/computer-task-contracts";
import type { ModelImageAttachment } from "./model-image";
import type { ComputerToolResult } from "./computer-tool-gateway";
import type { AppRepository } from "./database";
import type { HostBrowserBridge } from "./host-browser-bridge";
import { BrowserMediaStore } from "./browser-media-store";
import { AevorenBotError } from "./errors";

export interface HostComputerPlatform {
  status(): { supported: boolean; helperAvailable: boolean; screenPermission: string; accessibility: boolean };
  permission(kind: "screen" | "accessibility"): Promise<void>;
  listTargets(signal: AbortSignal): Promise<HostAppTarget[]>;
  capture(target: HostAppTarget, signal: AbortSignal): Promise<HostCapture>;
  input(operation: string, input: Record<string, unknown>, context: HostInputContext, signal: AbortSignal): Promise<void>;
}
const KEY = "computer.host.configuration";
const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("app"), pid: z.number().int().positive(), startedAt: z.number().positive(), windowId: z.number().int().positive(), appName: z.string().max(500), title: z.string().max(2000) }).strict(),
  z.object({ kind: z.literal("browser"), connectionId: z.string().min(1).max(200), tabId: z.number().int().nonnegative(), title: z.string().max(2000), url: z.string().max(8192) }).strict(),
]);
const configurationSchema = z.object({ version: z.number().int().positive(), target: z.enum(["builtin", "mac"]), enabled: z.boolean(), hostTarget: targetSchema.nullable().default(null) }).strict();
type Observation = { id: string; taskId: string; epoch: number; context: HostInputContext; width: number; height: number; at: number };
function sameTarget(a: HostComputerTarget, b: HostComputerTarget): boolean {
  return a.kind === "app" && b.kind === "app" ? a.pid === b.pid && a.startedAt === b.startedAt && a.windowId === b.windowId :
    a.kind === "browser" && b.kind === "browser" && a.connectionId === b.connectionId && a.tabId === b.tabId;
}

/** A host lease is pinned to an explicitly chosen background target, never the foreground desktop. */
export class HostComputerService {
  private owner: "ai" | "user" = "user";
  private epoch = 1;
  private lease: ComputerTask | undefined;
  private observation: Observation | undefined;
  private anchor: { x: number; y: number } | undefined;
  private controlledScope: BrowserScope | undefined;
  private operation: AbortController | undefined;
  private stopping = 0;
  private connectionGeneration = 0;
  private controlChanged: (scope: BrowserScope | undefined, owner: "ai" | "user") => Promise<void> = async () => {};
  constructor(private readonly repository: AppRepository, private readonly platform: HostComputerPlatform, private readonly media: BrowserMediaStore,
    private readonly browser?: HostBrowserBridge, private readonly openExtension?: () => Promise<void>) {}
  setControlLifecycle(callback: typeof this.controlChanged): void { this.controlChanged = callback; }
  configuration(): HostComputerConfiguration { const value = this.repository.getSetting(KEY); return value ? configurationSchema.parse(JSON.parse(value.value)) : { version: 1, target: "builtin", enabled: false, hostTarget: null }; }
  target(): ComputerTarget { return this.configuration().target; }
  hostTarget(): HostComputerTarget | null { return this.configuration().hostTarget; }
  status(): HostComputerStatus { return { configuration: this.configuration(), ...this.platform.status(), browserConnected: this.browser?.status().connected ?? false, owner: this.owner, epoch: this.epoch, busy: Boolean(this.lease) }; }
  async targets(): Promise<HostComputerTarget[]> {
    const signal = AbortSignal.timeout(10_000), status = this.platform.status();
    const [apps, tabs] = await Promise.all([status.supported && status.helperAvailable ? this.platform.listTargets(signal) : [], this.browser?.listTargets(signal) ?? []]);
    return [...apps, ...tabs];
  }
  async pairBrowser() {
    if (!this.browser) throw new AevorenBotError("HOST_BROWSER_UNAVAILABLE");
    const generation = ++this.connectionGeneration;
    await this.disconnectBrowser();
    if (generation !== this.connectionGeneration) throw new AevorenBotError("HOST_BROWSER_PAIRING_INVALID");
    const result = await this.browser.pair();
    if (generation !== this.connectionGeneration) throw new AevorenBotError("HOST_BROWSER_PAIRING_INVALID");
    return result;
  }
  async revokeBrowser(): Promise<void> { ++this.connectionGeneration; await this.disconnectBrowser(); }
  private async disconnectBrowser(): Promise<void> {
    // Invalidate transport authorization synchronously before waiting for task cleanup.
    await Promise.all([this.browser?.revoke(), this.control({ owner: "user", expectedEpoch: this.epoch })]);
  }
  async openBrowserExtension(): Promise<void> { if (!this.openExtension) throw new AevorenBotError("HOST_BROWSER_UNAVAILABLE"); await this.openExtension(); }
  async save(input: unknown): Promise<HostComputerStatus> {
    const next = configurationSchema.parse(input), current = this.configuration();
    if (next.version !== current.version) throw new AevorenBotError("COMPUTER_TASK_CONFLICT");
    if (next.target === "mac" && (!next.enabled || !this.platform.status().supported)) throw new AevorenBotError("HOST_COMPUTER_PERMISSION");
    if (next.hostTarget && (!current.hostTarget || !sameTarget(next.hostTarget, current.hostTarget))) {
      const canonical = (await this.targets()).find(target => sameTarget(target, next.hostTarget!));
      if (!canonical) throw new AevorenBotError("HOST_COMPUTER_TARGET_CHANGED");
      next.hostTarget = canonical;
    }
    // Enumeration is asynchronous; never overwrite a newer trusted UI save.
    if (this.configuration().version !== current.version) throw new AevorenBotError("COMPUTER_TASK_CONFLICT");
    this.repository.setSetting(KEY, JSON.stringify({ ...next, version: current.version + 1 }), false);
    if (!next.enabled || Boolean(current.hostTarget) !== Boolean(next.hostTarget) || current.hostTarget && next.hostTarget && !sameTarget(current.hostTarget, next.hostTarget)) await this.control({ owner: "user", expectedEpoch: this.epoch });
    return this.status();
  }
  permission(input: unknown): Promise<void> { return this.platform.permission(z.object({ kind: z.enum(["screen", "accessibility"]) }).strict().parse(input).kind); }
  async control(input: unknown): Promise<HostComputerStatus> {
    const parsed = z.object({ owner: z.enum(["ai", "user"]), expectedEpoch: z.number().int().positive() }).strict().parse(input);
    if (parsed.expectedEpoch !== this.epoch) throw new AevorenBotError("BROWSER_VERSION_CONFLICT");
    if (parsed.owner === "ai") { if (this.stopping) throw new AevorenBotError("HOST_COMPUTER_BUSY"); this.assertReady(this.hostTarget()); }
    if (parsed.owner === "user" && this.lease) this.controlledScope = this.lease;
    const controlScope = this.lease ?? this.controlledScope;
    this.owner = parsed.owner; this.epoch++; this.observation = undefined; this.anchor = undefined;
    this.operation?.abort();
    if (parsed.owner === "user") this.stopping++;
    try { await this.controlChanged(controlScope, parsed.owner); }
    finally { if (parsed.owner === "user") this.stopping--; }
    if (parsed.owner === "ai") this.controlledScope = undefined;
    return this.status();
  }
  private assertReady(target: HostComputerTarget | null | undefined): asserts target is HostComputerTarget {
    const status = this.platform.status();
    if (!this.configuration().enabled || !status.supported) throw new AevorenBotError("HOST_COMPUTER_PERMISSION");
    if (!target) throw new AevorenBotError("HOST_COMPUTER_TARGET_REQUIRED");
    const allowed = this.hostTarget();
    if (!allowed || !sameTarget(target, allowed)) throw new AevorenBotError("HOST_COMPUTER_TARGET_CHANGED");
    if (target.kind === "browser") {
      if (!this.browser?.isAuthorized(target)) throw new AevorenBotError("HOST_BROWSER_UNAVAILABLE");
    } else if (!status.helperAvailable || !status.accessibility || status.screenPermission !== "granted") throw new AevorenBotError("HOST_COMPUTER_PERMISSION");
  }
  assertAI(task: BrowserScope & Pick<ComputerTask, "hostTarget">): void {
    this.repository.assertSessionExecutor(task.sessionId, task.executorBotId); this.assertReady(task.hostTarget);
    if (this.owner !== "ai") throw new AevorenBotError("COMPUTER_USER_CONTROLLED");
  }
  async prepare(task: ComputerTask, signal: AbortSignal): Promise<ComputerToolResult> {
    this.assertAI(task); signal.throwIfAborted();
    if (this.lease && this.lease.id !== task.id) throw new AevorenBotError("HOST_COMPUTER_BUSY");
    this.lease = task; return this.screenshot(task, signal);
  }
  private async withCancellation<T>(signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.operation) throw new AevorenBotError("HOST_COMPUTER_BUSY");
    const controller = new AbortController(); this.operation = controller;
    try { return await action(AbortSignal.any([signal, controller.signal])); }
    finally { if (this.operation === controller) this.operation = undefined; }
  }
  private capture(target: HostComputerTarget, signal: AbortSignal): Promise<HostCapture> {
    return target.kind === "browser" ? this.browser!.capture(target, signal) : this.platform.capture(target, signal);
  }
  private async screenshot(task: ComputerTask, signal: AbortSignal): Promise<ComputerToolResult> {
    this.assertAI(task); const epoch = this.epoch;
    const capture = await this.withCancellation(signal, linked => this.capture(task.hostTarget!, linked)); this.assertAI(task); signal.throwIfAborted();
    if (epoch !== this.epoch || this.lease?.id !== task.id) throw new AevorenBotError("BROWSER_OBSERVATION_REQUIRED");
    const observation: Observation = { id: randomUUID(), taskId: task.id, epoch, context: capture.context, width: capture.width, height: capture.height, at: Date.now() };
    const sha256 = createHash("sha256").update(capture.bytes).digest("hex");
    await this.media.put(Buffer.from(capture.bytes), sha256, signal); this.assertAI(task); signal.throwIfAborted();
    if (epoch !== this.epoch) throw new AevorenBotError("BROWSER_OBSERVATION_REQUIRED");
    this.observation = observation;
    const reference = { id: randomUUID(), observationId: observation.id, name: "background-target.jpg", size: capture.bytes.length, mimeType: "image/jpeg", sha256, target: "mac", width: capture.width, height: capture.height, controlEpoch: epoch };
    const image: ModelImageAttachment = { reference, dataBase64: Buffer.from(capture.bytes).toString("base64"), isAuthorized: () => {
      try { this.assertAI(task); return this.epoch === epoch && this.lease?.id === task.id && this.observation?.id === observation.id &&
        (capture.context.kind !== "browser" || Boolean(this.browser?.isAuthorized(capture.context.target, capture.context))); } catch { return false; }
    } };
    return { result: { media: reference, expectedEpoch: epoch, imageTransfer: "prepared_real_pixels" }, images: [image] };
  }
  async execute(task: ComputerTask, operation: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ComputerToolResult> {
    this.assertAI(task); signal.throwIfAborted();
    if (this.lease?.id !== task.id) throw new AevorenBotError("HOST_COMPUTER_BUSY");
    if (operation === "computer.view") return { result: { owner: this.owner, epoch: this.epoch, target: "mac", hostTarget: task.hostTarget } };
    if (input.expectedEpoch !== this.epoch) throw new AevorenBotError("BROWSER_OBSERVATION_REQUIRED");
    if (operation === "computer.screenshot") return this.screenshot(task, signal);
    if (operation === "browser.read" && task.hostTarget?.kind === "browser") {
      const epoch = this.epoch, result = await this.withCancellation(signal, linked => this.browser!.read(task.hostTarget as import("@shared/host-computer-targets").HostBrowserTarget, linked));
      this.assertAI(task); signal.throwIfAborted();
      if (epoch !== this.epoch) throw new AevorenBotError("BROWSER_OBSERVATION_REQUIRED");
      return { result };
    }
    const observation = this.observation;
    if (!observation || observation.taskId !== task.id || input.observationId !== observation.id || Date.now() - observation.at > 30_000) throw new AevorenBotError("BROWSER_OBSERVATION_REQUIRED");
    if (input.button !== undefined && !["left", "right"].includes(String(input.button))) throw new AevorenBotError("INVALID_REQUEST");
    const command = { ...input }, previousAnchor = this.anchor;
    const transform = (point: { x: number; y: number }): { x: number; y: number } => {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= observation.width || point.y >= observation.height) throw new AevorenBotError("INVALID_REQUEST");
      return { x: point.x * observation.context.width / observation.width, y: point.y * observation.context.height / observation.height };
    };
    if (typeof command.x === "number" && typeof command.y === "number") Object.assign(command, transform(command as { x: number; y: number }));
    if (Array.isArray(command.path)) command.path = command.path.map(point => transform(point));
    if ((operation === "computer.type" || operation === "computer.key") && this.anchor && command.x === undefined && command.y === undefined) Object.assign(command, this.anchor);
    const controller = new AbortController(), actionSignal = AbortSignal.any([signal, controller.signal]); this.operation = controller;
    this.observation = undefined; this.anchor = undefined;
    try {
      if (task.hostTarget?.kind === "browser") {
        if (operation === "browser.navigate") { this.anchor = undefined; await this.browser!.navigate(task.hostTarget, String(command.url), observation.context, actionSignal); }
        else await this.browser!.input(operation.slice(9), command, observation.context, actionSignal);
      } else await this.platform.input(operation.slice(9), command, observation.context, actionSignal);
      if (operation === "computer.click") this.anchor = { x: command.x as number, y: command.y as number };
      else if (operation === "computer.type" || operation === "computer.key" && ["meta+a", "cmd+a", "command+a"].includes(String(command.key).toLowerCase())) this.anchor = typeof command.x === "number" && typeof command.y === "number" ? { x: command.x, y: command.y } : previousAnchor;
    } finally { if (this.operation === controller) this.operation = undefined; }
    this.assertAI(task); signal.throwIfAborted();
    try { const frame = await this.screenshot(task, signal); return { result: { action: { executed: true }, feedback: frame.result }, images: frame.images }; }
    catch (error) { signal.throwIfAborted(); this.assertAI(task); return { result: { action: { executed: true }, feedback: { status: "unavailable", actionAlreadyExecuted: true, code: error instanceof AevorenBotError ? error.code : "BROWSER_UNAVAILABLE" } } }; }
  }
  async preview(scope: BrowserScope): Promise<{ dataUrl: string; capturedAt: string }> {
    this.repository.assertSessionExecutor(scope.sessionId, scope.executorBotId); const target = this.hostTarget(); this.assertReady(target);
    const capture = await this.capture(target, AbortSignal.timeout(10_000));
    this.assertReady(target);
    if (!this.hostTarget() || !sameTarget(target, this.hostTarget()!)) throw new AevorenBotError("HOST_COMPUTER_TARGET_CHANGED");
    return { dataUrl: `data:image/jpeg;base64,${Buffer.from(capture.bytes).toString("base64")}`, capturedAt: new Date().toISOString() };
  }
  async release(task: ComputerTask): Promise<void> { if (this.lease?.id === task.id) { this.operation?.abort(); this.lease = undefined; this.observation = undefined; this.anchor = undefined; this.epoch++; } }
}
