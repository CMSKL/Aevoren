import type { ComputerStartup } from "@shared/browser-contracts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { BrowserActionInput, BrowserChangedEvent, BrowserClickInput, BrowserDownloadInput, BrowserDownloadsPage,
  BrowserEpochInput, BrowserMutationInput, BrowserNavigateInput, BrowserNewTabInput, BrowserObserveInput, BrowserPage, BrowserPageMutationInput,
  BrowserReadInput, BrowserScope, BrowserScrollInput, BrowserSession, BrowserTypeInput, BrowserKeyInput, BrowserWorkerHealth,
  ComputerWindowInput, DesktopWindow, ComputerActionInput, ComputerActionResult, ComputerButtonInput, ComputerDragInput, ComputerKeyInput, ComputerClickInput, ComputerControlInput, ComputerOwner, ComputerScreenshot, ComputerScreenshotInput, ComputerScrollInput, ComputerTypeInput,
  ComputerView, ComputerVncTicket, PreviewCloseInput, PreviewOpenInput, ServicePreview } from "@shared/browser-contracts";
import { BROWSER_WORKER_VERSION } from "@shared/browser-contracts";
import { ENV_WORKER_VERSION } from "@shared/environment-contracts";
import * as schemas from "@shared/browser-schemas";
import type { AppRepository } from "./database";
import type { EnvironmentService } from "./environment-service";
import type { SecretCodec } from "./settings";
import type { ModelImageAttachment } from "./model-image";
import { AevorenBotError } from "./errors";
import { DockerCommandError } from "./docker-driver";
import { openLocalDocker } from "./docker-desktop";
import { BrowserDockerDriver, DockerMemoryError } from "./browser-docker-driver";
import { ExecutionWorkerClient, ExecutionWorkerError } from "./execution-worker-client";
import { BrowserMediaStore, verifiedFrame } from "./browser-media-store";
import { BrowserViewServer } from "./browser-view-server";

export type BrowserCallContext = { actor?: ComputerOwner; signal?: AbortSignal; operationId?: string; runtimeRunId?: string };
export type BrowserMutationCall<T extends { clientNonce: string }> = Omit<T, "clientNonce"> & { clientNonce?: string };
function scope(input: BrowserScope): BrowserScope { return schemas.browserScopeSchema.parse({ sessionId: input.sessionId, executorBotId: input.executorBotId }); }
function operationId(seed: string): string { const hash = createHash("sha256").update(seed).digest("hex"); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`; }
function failure(error: unknown): AevorenBotError {
  if (error instanceof AevorenBotError) return error;
  if (error instanceof DockerMemoryError) return new AevorenBotError("COMPUTER_MEMORY_INSUFFICIENT",
    `当前 Docker 内存预算不足，无法安全启动更多电脑（需要 ${error.requiredMiB} MiB，可用 ${error.availableMiB} MiB）。`, undefined,
    { requiredMiB: error.requiredMiB, availableMiB: error.availableMiB });
  if (error instanceof DockerCommandError && error.code === "DOCKER_MEMORY_UNAVAILABLE") return new AevorenBotError("COMPUTER_MEMORY_UNAVAILABLE");
  if (error instanceof ExecutionWorkerError) {
    if (/USER_CONTROL/.test(error.code)) return new AevorenBotError("COMPUTER_USER_CONTROLLED");
    if (/CONTROL_CHANGED/.test(error.code)) return new AevorenBotError("COMPUTER_CONTROL_CHANGED");
    if (/OBSERVATION/.test(error.code)) return new AevorenBotError("BROWSER_OBSERVATION_REQUIRED");
    if (/OPERATION_UNKNOWN|OPERATION_CONFLICT/.test(error.code)) return new AevorenBotError("TOOL_STATE_INVALID", "上次操作结果未确认，操作未重复执行；请重新观察实际状态。");
    if (/OPERATION_CANCELLED/.test(error.code)) return new AevorenBotError("TOOL_EXECUTION_CANCELLED");
    if (/NAVIGATION_FAILED/.test(error.code)) return new AevorenBotError("BROWSER_NAVIGATION_FAILED");
    if (/DESKTOP|ENGINE_STOPPED/.test(error.code)) return new AevorenBotError("COMPUTER_DESKTOP_UNAVAILABLE");
  }
  return new AevorenBotError("BROWSER_UNAVAILABLE");
}
function engineStopped(error: unknown): boolean {
  return error instanceof ExecutionWorkerError && error.code === "BROWSER_ENGINE_STOPPED";
}

function waitForPreparation<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = (): void => { reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** One host-owned business service for the trusted interface and scoped AI tools. */
export class BrowserService {
  private readonly media: BrowserMediaStore;
  private readonly viewers = new BrowserViewServer();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly active = new Map<string, { scope: BrowserScope; runtimeRunId?: string }>();
  private readonly controls = new Map<string, { scope: BrowserScope; owner: ComputerOwner; previousEpoch: number; claimedEpoch: number; bootId: string | null; completedEpoch?: number }>();
  private readonly ticketResults = new Map<string, ComputerVncTicket>();
  private readonly startupClosing = new AbortController();
  private readonly startups = new Map<string, ComputerStartup>();
  private readonly healthChecks = new Map<string, symbol>();
  private readonly startupRequests = new Map<string, { controller: AbortController; promise: Promise<BrowserSession> }>();
  private preparing?: Promise<import("./docker-driver").DockerImage>;
  private closing = false;
  private readonly demonstrationClosing = new AbortController();
  private readonly demonstrationPending = new Set<Promise<unknown>>();
  private stopLifecycle?: (scope: BrowserScope, remove: boolean) => Promise<void>;
  setStopLifecycle(callback: (scope: BrowserScope, remove: boolean) => Promise<void>): void { this.stopLifecycle = callback; }
  private controlLifecycle?: (scope: BrowserScope, owner: ComputerOwner) => Promise<void>;
  setControlLifecycle(callback: (scope: BrowserScope, owner: ComputerOwner) => Promise<void>): void { this.controlLifecycle = callback; }
  constructor(private readonly repository: AppRepository, private readonly codec: SecretCodec, private readonly contextPath: string, mediaRoot: string,
    private readonly environments: EnvironmentService, private readonly changed: (event: BrowserChangedEvent) => void = () => undefined,
    private readonly docker: BrowserDockerDriver = new BrowserDockerDriver()) { this.media = new BrowserMediaStore(mediaRoot); }
  private async locked<T>(input: BrowserScope, work: () => Promise<T>): Promise<T> {
    const key = `${input.sessionId}:${input.executorBotId}`, previous = this.locks.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(work); this.locks.set(key, pending);
    try { return await pending; } finally { if (this.locks.get(key) === pending) this.locks.delete(key); }
  }
  private actor(context: BrowserCallContext): ComputerOwner { return context.actor ?? "user"; }
  private live(input: BrowserScope, context: BrowserCallContext): void {
    context.signal?.throwIfAborted();
    if (this.closing) throw new AevorenBotError("BROWSER_UNAVAILABLE");
    this.repository.assertSessionExecutor(input.sessionId, input.executorBotId);
    if (context.runtimeRunId) { const run = this.repository.getRuntimeRun(context.runtimeRunId); if (run.sessionId !== input.sessionId || run.executorBotId !== input.executorBotId) throw new AevorenBotError("BROWSER_SCOPE_INVALID"); }
  }
  private emit(input: BrowserScope, type: Exclude<BrowserChangedEvent["type"], "startup">, beforeVersion?: number): void {
    const current = this.repository.browsers.get(input); if (!current || beforeVersion === current.version) return;
    this.changed({ ...scope(input), type, browserSessionId: current.id, controlEpoch: current.controlEpoch });
  }
  private parseMutation<T extends { clientNonce: string }>(schema: z.ZodType<T>, input: BrowserMutationCall<T>, context: BrowserCallContext): T {
    return schema.parse({ ...input, clientNonce: context.operationId ?? input.clientNonce });
  }
  private intent(input: BrowserScope & { clientNonce: string }, name: string, context: BrowserCallContext): string {
    return context.operationId ?? operationId(`${input.sessionId}:${input.executorBotId}:${name}:${input.clientNonce}`);
  }
  private async client(input: BrowserScope): Promise<ExecutionWorkerClient> {
    const record = this.repository.browsers.getInternal(input);
    if (!record?.workerPort || !record.encryptedToken) throw new AevorenBotError("BROWSER_UNAVAILABLE");
    return new ExecutionWorkerClient(record.workerPort, this.codec.decrypt(record.encryptedToken), record.environmentId);
  }
  private async health(input: BrowserScope, signal?: AbortSignal, client?: ExecutionWorkerClient): Promise<BrowserWorkerHealth> {
    const record = this.repository.browsers.getInternal(input); if (!record) throw new AevorenBotError("BROWSER_NOT_FOUND");
    const health = schemas.browserWorkerHealthSchema.parse(await (client ?? await this.client(input)).request("/v1/health", "GET", undefined, signal));
    if (health.browserSessionId !== record.id || health.environmentId !== record.environmentId || health.workerVersion !== record.workerVersion) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
    return health;
  }
  private async syncStartedControl(input: BrowserScope, initial: BrowserWorkerHealth, context: BrowserCallContext): Promise<BrowserWorkerHealth> {
    const saved = this.repository.browsers.get(input)!, view = this.repository.browsers.view(input)!;
    let health = initial;
    // A new engine can have no persisted Worker lease. Advance an already-AI
    // lease beyond the saved epoch; never infer a human return from a new boot.
    if (saved.bootId && saved.bootId !== health.bootId && view.owner === "ai" && health.control.owner === "ai") {
      const bootId = health.bootId;
      while (health.control.controlEpoch <= saved.controlEpoch) {
        const expectedEpoch = health.control.controlEpoch;
        await (await this.client(input)).request("/v1/computer/return", "POST", {
          actor: "user", expectedEpoch, operationId: operationId(`startup:${saved.id}:${bootId}:${expectedEpoch}`),
        }, context.signal);
        health = await this.health(input, context.signal); this.live(input, context);
        if (health.bootId !== bootId || health.control.owner !== "ai" || health.control.controlEpoch <= expectedEpoch) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
      }
    }
    this.repository.browsers.syncControl(input, health.control, health.bootId);
    return health;
  }
  demonstrationRequest(input: BrowserScope, action: "status" | "start" | "stop" | "discard", payload: { id: string; expectedEpoch: number } | undefined, context: BrowserCallContext = {}): Promise<unknown> {
    if (this.closing) return Promise.reject(new AevorenBotError("BROWSER_UNAVAILABLE"));
    const pending = this.requestDemonstration(input, action, payload, { ...context, signal: AbortSignal.any([this.demonstrationClosing.signal, ...(context.signal ? [context.signal] : [])]) });
    this.demonstrationPending.add(pending); void pending.finally(() => this.demonstrationPending.delete(pending)).catch(() => undefined); return pending;
  }
  private async requestDemonstration(input: BrowserScope, action: "status" | "start" | "stop" | "discard", payload: { id: string; expectedEpoch: number } | undefined, context: BrowserCallContext = {}): Promise<unknown> {
    const target = scope(input); this.live(target, context);
    const health = await this.health(target, context.signal); this.live(target, context);
    if (!health.capabilities.includes("demonstration") || health.workerVersion !== BROWSER_WORKER_VERSION) throw new AevorenBotError("DEMONSTRATION_UNSUPPORTED");
    if (action !== "status" && (context.actor === "ai" || !payload || payload.expectedEpoch !== health.control.controlEpoch)) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
    try {
      const result = await (await this.client(target)).request(`/v1/demonstrations/${action}`, action === "status" ? "GET" : "POST", action === "status" ? undefined : { actor: "user", id: payload!.id, expectedEpoch: payload!.expectedEpoch }, context.signal);
      this.live(target, context); return result;
    } catch (error) {
      if (error instanceof ExecutionWorkerError && error.code === "DEMONSTRATION_INPUT_UNSUPPORTED") throw new AevorenBotError("DEMONSTRATION_INPUT_UNSUPPORTED");
      if (error instanceof ExecutionWorkerError && error.code === "DEMONSTRATION_VIEWER_REQUIRED") throw new AevorenBotError("DEMONSTRATION_VIEWER_REQUIRED");
      if (error instanceof ExecutionWorkerError && error.code === "DEMONSTRATION_STATE_INVALID") throw new AevorenBotError("DEMONSTRATION_STATE_INVALID");
      if (error instanceof ExecutionWorkerError && error.code === "DEMONSTRATION_NOT_FOUND") throw new AevorenBotError("DEMONSTRATION_NOT_FOUND");
      if (error instanceof ExecutionWorkerError && error.code === "DEMONSTRATION_LIMIT") throw new AevorenBotError("DEMONSTRATION_LIMIT");
      throw failure(error);
    }
  }
  async get(input: BrowserScope, context: BrowserCallContext = {}): Promise<BrowserSession | null> {
    const target = scope(input); this.live(target, context); const existing = this.repository.browsers.get(target); if (!existing) return null;
    const key = `${target.sessionId}:${target.executorBotId}`;
    if (this.locks.has(key)) return existing;
    this.healthChecks.set(key, Symbol());
    const currentCheck = this.healthGuard(target, existing);
    const before = existing.version;
    try {
      const container = await this.docker.inspectBrowser(existing.id, existing.environmentId, context.signal);
      if (!currentCheck()) { this.live(target, context); return this.repository.browsers.get(target); }
      this.live(target, context);
      if (!container || container.state !== "running") {
        this.repository.browsers.update(target, before, { state: "stopped" });
        this.healthStatus(target, "stopped", "电脑已停止，工作文件仍保留", "BROWSER_UNAVAILABLE");
      }
      else {
        const privateRecord = this.repository.browsers.getInternal(target)!;
        if (container.imageId !== privateRecord.imageDigest || !container.workerPort || !privateRecord.encryptedToken) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
        const health = await this.health(target, context.signal, new ExecutionWorkerClient(container.workerPort, this.codec.decrypt(privateRecord.encryptedToken), existing.environmentId));
        if (!currentCheck()) { this.live(target, context); return this.repository.browsers.get(target); }
        this.live(target, context);
        this.repository.browsers.updateConnection(target, { workerPort: container.workerPort, containerId: container.id });
        this.repository.browsers.syncControl(target, health.control, health.bootId);
        this.repository.browsers.update(target, this.repository.browsers.get(target)!.version, { state: "running" });
        this.healthStatus(target, "ready", "电脑已就绪");
      }
    } catch (error) {
      context.signal?.throwIfAborted(); this.live(target, context);
      if (!currentCheck()) return this.repository.browsers.get(target);
      const current = this.repository.browsers.get(target); if (!current) throw failure(error);
      const stopped = engineStopped(error);
      this.repository.browsers.update(target, current.version, { state: stopped ? "error" : "unknown" });
      this.healthStatus(target, "error", stopped ? "电脑引擎已停止，请检查当前电脑后重新启动" : "暂时无法确认电脑连接，请检查 Docker 和当前电脑状态", stopped ? "COMPUTER_DESKTOP_UNAVAILABLE" : "BROWSER_UNAVAILABLE");
    }
    this.live(target, context); this.emit(target, "browser", before); return this.repository.browsers.get(target);
  }
  private healthGuard(input: BrowserScope, before: BrowserSession): () => boolean {
    const key = `${input.sessionId}:${input.executorBotId}`, attempt = this.startups.get(key)?.attemptId, check = this.healthChecks.get(key);
    return () => {
      if (this.closing || this.locks.has(key) || this.healthChecks.get(key) !== check || this.startups.get(key)?.attemptId !== attempt) return false;
      const current = this.repository.browsers.get(input);
      return current?.id === before.id && current.version === before.version;
    };
  }
  private healthStatus(input: BrowserScope, phase: "ready" | "error" | "stopped", message: string, errorCode: string | null = null): void {
    const key = `${input.sessionId}:${input.executorBotId}`, current = this.startups.get(key), bootId = this.repository.browsers.get(input)?.bootId ?? null;
    const blocker = phase === "error" ? "startup-failed" as const : null;
    const startup: ComputerStartup = { attemptId: current?.attemptId ?? randomUUID(), phase, message, blocker, errorCode, checkedAt: new Date().toISOString(), bootId };
    this.startups.set(key, startup);
    if ((current || phase !== "ready") && (current?.phase !== phase || current.message !== message || current.blocker !== blocker || (current.errorCode ?? null) !== errorCode || current.bootId !== bootId)) this.changed({ ...scope(input), type: "startup", startup });
  }
  async view(input: BrowserScope, context: BrowserCallContext = {}): Promise<ComputerView | null> { await this.get(input, context); return this.repository.browsers.view(input); }
  private async bundleDigest(): Promise<string> { const hash = createHash("sha256"); for (const name of ["index.mjs", "engine.mjs", "Dockerfile", "package.json"]) { hash.update(name); hash.update(await readFile(join(this.contextPath, name))); } return hash.digest("hex"); }
  private async prepare(signal?: AbortSignal) {
    if (this.preparing) return this.preparing;
    const task = (async () => { const digest = await this.bundleDigest(), existing = await this.docker.inspectBrowserImage(undefined, signal);
      return existing?.bundleSha256 === digest && existing.workerVersion === BROWSER_WORKER_VERSION ? existing : this.docker.initializeBrowser(this.contextPath, digest, signal); })();
    this.preparing = task; try { return await task; } finally { if (this.preparing === task) this.preparing = undefined; }
  }
  startupStatus(input: BrowserScope): ComputerStartup | null {
    this.live(scope(input), {}); return this.startups.get(`${input.sessionId}:${input.executorBotId}`) ?? null;
  }
  private startupPhase(input: BrowserScope, phase: ComputerStartup["phase"], message: string, blocker: ComputerStartup["blocker"] = null, errorCode: string | null = null): void {
    const key = `${input.sessionId}:${input.executorBotId}`, current = this.startups.get(key);
    if (!current) return;
    const startup = { ...current, phase, message, blocker, errorCode, checkedAt: new Date().toISOString(), bootId: this.repository.browsers.get(input)?.bootId ?? null }; this.startups.set(key, startup);
    this.changed({ ...scope(input), type: "startup", startup });
  }
  cancelStartup(input: BrowserScope & { attemptId: string }): ComputerStartup | null {
    const parsed = schemas.browserScopeSchema.extend({ attemptId: z.string().uuid() }).parse(input);
    this.live(parsed, {});
    const key = `${parsed.sessionId}:${parsed.executorBotId}`, current = this.startups.get(key);
    if (current?.attemptId === parsed.attemptId) this.startupRequests.get(key)?.controller.abort();
    return current ?? null;
  }
  async openDocker(input: BrowserScope): Promise<void> { this.live(scope(input), {}); await openLocalDocker(); }
  start(input: BrowserMutationCall<BrowserMutationInput>, context: BrowserCallContext = {}): Promise<BrowserSession> {
    const parsed = this.parseMutation(schemas.browserMutationSchema, input, context); this.live(parsed, context);
    const key = `${parsed.sessionId}:${parsed.executorBotId}`, existing = this.startupRequests.get(key);
    const saved = this.repository.browsers.get(parsed);
    if (parsed.expectedVersion !== undefined && saved && saved.version !== parsed.expectedVersion) return Promise.reject(new AevorenBotError("BROWSER_VERSION_CONFLICT"));
    if (saved?.state === "running" && this.actor(context) === "ai" && this.repository.browsers.view(parsed)?.owner === "user") return Promise.resolve(saved);
    if (existing) return context.signal ? waitForPreparation(existing.promise, context.signal) : existing.promise;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.startupClosing.signal, ...(context.signal ? [context.signal] : [])]);
    this.startups.set(key, { attemptId: randomUUID(), phase: "checking", message: "正在检查电脑", blocker: null });
    const promise = Promise.resolve().then(async () => {
      let releaseMemory: (() => Promise<void>) | undefined;
      try {
        this.live(parsed, { ...context, signal }); this.startupPhase(parsed, "checking", "正在检查电脑");
        const probe = await this.environments.probe(signal); signal.throwIfAborted(); this.live(parsed, context);
        if (!probe.available) {
          const blocker = !probe.dockerInstalled ? "docker-missing" : probe.dockerStatus === "unsupported" ? "docker-unsupported" : "docker-stopped";
          const message = blocker === "docker-missing" ? "电脑需要 Docker 才能运行" : blocker === "docker-stopped" ? "Docker 尚未启动" : "当前 Docker 环境不支持 Linux 电脑";
          this.startupPhase(parsed, "error", message, blocker, "ENVIRONMENT_UNAVAILABLE"); throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE", message);
        }
        releaseMemory = await this.docker.reserveComputer(() => this.repository.environments.getInternal(parsed)?.id, signal);
        const previousEnvironment = this.repository.environments.getInternal(parsed);
        const environment = await this.environments.get(scope(parsed)); this.live(parsed, { ...context, signal });
        if (!environment) {
          this.startupPhase(parsed, "preparing-environment", "正在准备运行组件");
          await waitForPreparation(this.environments.initialize(this.startupClosing.signal), signal); this.live(parsed, { ...context, signal });
        }
        if (environment?.state !== "running") {
          this.startupPhase(parsed, "starting-environment", "正在启动工作空间");
          await this.environments.start(scope(parsed), signal); this.live(parsed, { ...context, signal });
          if (previousEnvironment?.containerId && previousEnvironment.containerId !== this.repository.environments.getInternal(parsed)?.containerId) {
            // A recreated command container has a new private network address.
            // Recreate only its companion process, preserving pinned data/image.
            await this.locked(parsed, async () => {
              const saved = this.repository.browsers.get(parsed);
              if (saved) { this.viewers.revoke(parsed); await this.docker.stopBrowser(saved.id, saved.environmentId, true); }
            });
          }
          if (this.repository.browsers.view(parsed)?.owner === "user") await this.environments.pauseAutomation(scope(parsed), true, signal);
        }
        const result = await waitForPreparation(this.locked(parsed, () => this.startPrepared(parsed, { ...context, signal })), signal);
        this.startupPhase(parsed, "ready", "电脑已就绪"); return result;
      } catch (error) {
        if (signal.aborted) { this.startupPhase(parsed, "cancelled", "电脑启动已取消"); throw new AevorenBotError("TOOL_EXECUTION_CANCELLED"); }
        if (this.startups.get(key)?.blocker) throw error;
        const problem = error instanceof DockerCommandError && error.code === "DOCKER_TIMEOUT"
          ? new AevorenBotError("BROWSER_UNAVAILABLE", "准备电脑超时，请检查网络后重试。") : failure(error);
        this.startupPhase(parsed, "error", problem.message, "startup-failed", problem.code); throw problem;
      } finally { await releaseMemory?.(); }
    });
    this.startupRequests.set(key, { controller, promise });
    void promise.finally(() => { if (this.startupRequests.get(key)?.promise === promise) this.startupRequests.delete(key); }).catch(() => undefined);
    return promise;
  }
  private async restoreLayout(scope: BrowserScope): Promise<void> {
    const environment = this.repository.environments.get(scope);
    if (!environment) return;
    const saved = this.repository.computerTasks.layoutMigration(environment.id);
    if (!saved) return;
    await this.environments.restoreComputerLayout(scope, saved.execution);
    const container = await this.docker.restoreBrowser(saved.id, environment.id);
    const { encryptedToken, imageRef, imageDigest, workerVersion, platform } = saved;
    this.repository.browsers.updateConnection(scope, { encryptedToken, imageRef, imageDigest, workerVersion, platform,
      containerId: container?.id ?? saved.containerId, workerPort: container?.workerPort ?? saved.workerPort });
    this.repository.computerTasks.saveLayoutMigration(null, environment.id);
  }
  private async upgradeLayout(scope: BrowserScope, context: BrowserCallContext): Promise<void> {
    const saved = this.repository.browsers.getInternal(scope);
    if (!saved) return;
    const container = await this.docker.inspectBrowser(saved.id, saved.environmentId, context.signal);
    const execution = this.repository.environments.get(scope)!;
    const legacyBrowser = container ? container.layoutVersion === 1 : Boolean(saved.imageDigest && saved.workerVersion !== BROWSER_WORKER_VERSION);
    if (!legacyBrowser && execution.workerVersion === ENV_WORKER_VERSION) return;
    if (this.repository.browsers.view(scope)?.owner === "user") throw new AevorenBotError("BROWSER_VERSION_CONFLICT", "电脑需要升级；上次接管状态仍保留，请先归还控制。");
    if ([...this.active.values()].some(value => value.scope.sessionId === scope.sessionId && value.scope.executorBotId === scope.executorBotId)) throw new AevorenBotError("BROWSER_VERSION_CONFLICT", "电脑需要升级；当前电脑操作尚未结束，请稍后重试。");
    const image = await waitForPreparation(this.prepare(this.startupClosing.signal), context.signal!);
    await this.environments.initialize(context.signal);
    await this.environments.withIdleComputer(scope, async () => {
      const { workerVersion, imageRef, imageDigest, platform } = execution;
      this.repository.computerTasks.saveLayoutMigration({ ...saved, execution: { workerVersion, imageRef, imageDigest, platform } }, saved.environmentId);
      try {
        this.viewers.revoke(scope);
        await this.docker.archiveBrowser(saved.id, saved.environmentId, context.signal);
        if (legacyBrowser) await this.docker.copyLegacyVolumes(saved.id, saved.environmentId, image, context.signal);
        await this.environments.upgradeComputerLayout(scope, context.signal);
        const token = this.codec.decrypt(saved.encryptedToken!);
        const created = await this.docker.createBrowser(saved.id, saved.environmentId, image, token, context.signal);
        const client = new ExecutionWorkerClient(created.workerPort!, token, saved.environmentId);
        const health = schemas.browserWorkerHealthSchema.parse(await client.waitHealthy(context.signal, 50_000));
        if (health.browserSessionId !== saved.id || health.workerVersion !== image.workerVersion) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
        this.repository.browsers.transaction(() => {
          this.repository.browsers.updateConnection(scope, { encryptedToken: saved.encryptedToken, imageRef: image.ref, imageDigest: image.id, workerVersion: image.workerVersion, platform: image.platform, containerId: created.id, workerPort: created.workerPort });
          this.repository.browsers.syncControl(scope, health.control, health.bootId);
          this.repository.browsers.update(scope, this.repository.browsers.get(scope)!.version, { state: "running", activePageId: null });
          this.repository.computerTasks.saveLayoutMigration(null, saved.environmentId);
        });
      } catch (error) { await this.restoreLayout(scope); throw error; }
    });
  }
  private async startPrepared(parsed: BrowserMutationInput, context: BrowserCallContext): Promise<BrowserSession> {
      this.live(parsed, context); const environment = this.repository.environments.get(parsed);
      if (this.actor(context) === "ai" && this.repository.browsers.view(parsed)?.owner === "user") throw new AevorenBotError("COMPUTER_USER_CONTROLLED");
      if (!environment || environment.state !== "running") throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE");
      await this.restoreLayout(scope(parsed));
      const current = this.repository.browsers.get(parsed);
      if (current && parsed.expectedVersion !== undefined && current.version !== parsed.expectedVersion) throw new AevorenBotError("BROWSER_VERSION_CONFLICT");
      await this.upgradeLayout(scope(parsed), context);
      let record = this.repository.browsers.getInternal(parsed);
      if (record?.state === "running") {
        const existing = await this.docker.inspectBrowser(record.id, record.environmentId, context.signal);
        if (existing?.state === "running" && existing.imageId === record.imageDigest) {
          const healthy = await this.health(parsed, context.signal); await this.environments.reconcileBinding(scope(parsed), context.signal, this.repository.browsers.view(parsed)?.owner === "user"); this.live(parsed, context);
          await this.syncStartedControl(parsed, healthy, context);
          this.emit(parsed, "browser", current!.version); return this.repository.browsers.get(parsed)!;
        }
      }
      this.startupPhase(parsed, "preparing-browser", "正在准备浏览器组件");
      const image = record?.imageDigest ? await this.docker.inspectBrowserImage(record.imageDigest, context.signal) : await waitForPreparation(this.prepare(this.startupClosing.signal), context.signal!);
      this.live(parsed, context); if (!image || !this.codec.isAvailable()) throw new AevorenBotError("BROWSER_UNAVAILABLE");
      if (!record) { this.repository.browsers.ensure(parsed, { environmentId: environment.id }); record = this.repository.browsers.getInternal(parsed)!; }
      const token = record.encryptedToken ? this.codec.decrypt(record.encryptedToken) : randomBytes(32).toString("hex");
      this.repository.browsers.updateConnection(parsed, { encryptedToken: this.codec.encrypt(token), imageRef: image.ref, imageDigest: image.id, workerVersion: image.workerVersion, platform: image.platform });
      this.repository.browsers.update(parsed, this.repository.browsers.get(parsed)!.version, { state: "starting" });
      this.startupPhase(parsed, "starting-browser", "正在连接电脑");
      try {
        const old = await this.docker.inspectBrowser(record.id, environment.id, context.signal);
        if (old && old.imageId !== image.id) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
        const container = old?.state === "running" ? old : old ? await this.docker.startBrowser(record.id, environment.id, context.signal) : await this.docker.createBrowser(record.id, environment.id, image, token, context.signal);
        this.repository.browsers.updateConnection(parsed, { containerId: container.id, workerPort: container.workerPort });
        await this.environments.reconcileBinding(scope(parsed), context.signal, this.repository.browsers.view(parsed)?.owner === "user"); this.live(parsed, context);
        const client = await this.client(parsed); await client.waitHealthy(context.signal, 50_000);
        const initial = await this.health(parsed, context.signal); this.live(parsed, context);
        const health = await this.syncStartedControl(parsed, initial, context);
        this.repository.browsers.update(parsed, this.repository.browsers.get(parsed)!.version, { state: "running" });
        await this.tabs({ ...scope(parsed), expectedEpoch: health.control.controlEpoch }, context); this.emit(parsed, "browser"); return this.repository.browsers.get(parsed)!;
      } catch (error) { const now = this.repository.browsers.get(parsed); if (now) this.repository.browsers.update(parsed, now.version, { state: "unknown" }); throw failure(error); }
  }
  async stop(input: BrowserMutationCall<BrowserMutationInput>, context: BrowserCallContext = {}): Promise<BrowserSession> {
    const parsed = this.parseMutation(schemas.browserMutationSchema, input, context); this.live(parsed, context);
    const saved = this.repository.browsers.get(parsed);
    if (saved && parsed.expectedVersion !== undefined && saved.version !== parsed.expectedVersion) throw new AevorenBotError("BROWSER_VERSION_CONFLICT");
    this.healthChecks.set(`${parsed.sessionId}:${parsed.executorBotId}`, Symbol());
    this.startupRequests.get(`${parsed.sessionId}:${parsed.executorBotId}`)?.controller.abort();
    await this.stopLifecycle?.(scope(parsed), false);
    return this.locked(parsed, async () => { this.live(parsed, context); const current = this.repository.browsers.get(parsed); if (!current) throw new AevorenBotError("BROWSER_NOT_FOUND");
      if (parsed.expectedVersion !== undefined && current.version !== parsed.expectedVersion) throw new AevorenBotError("BROWSER_VERSION_CONFLICT");
      if (this.actor(context) === "ai" && this.repository.browsers.view(parsed)?.owner === "user") throw new AevorenBotError("COMPUTER_USER_CONTROLLED");
      this.viewers.revoke(parsed); await this.docker.stopBrowser(current.id, current.environmentId); this.live(parsed, context);
      const result = this.repository.browsers.update(parsed, this.repository.browsers.get(parsed)!.version, { state: "stopped" }); this.healthStatus(parsed, "stopped", "电脑已停止，工作文件仍保留", "BROWSER_UNAVAILABLE"); this.emit(parsed, "browser", current.version); return result; });
  }
  private access(input: BrowserEpochInput, context: BrowserCallContext, fresh = false): void { this.live(input, context); const method = fresh ? "assertFresh" : "assertAccess"; this.repository.browsers[method](input, input.expectedEpoch, this.actor(context)); }
  private wire(input: Record<string, unknown>, context: BrowserCallContext, id?: string): Record<string, unknown> {
    const body = Object.fromEntries(Object.entries(input).filter(([key]) => !["sessionId", "executorBotId", "clientNonce", "expectedVersion"].includes(key)));
    return { ...body, actor: this.actor(context), ...(id ? { operationId: id } : {}) };
  }
  private async request(input: BrowserEpochInput, path: string, method: "GET" | "POST", body: unknown, context: BrowserCallContext): Promise<unknown> {
    this.access(input, context);
    const before = this.repository.browsers.get(input)!, currentCheck = this.healthGuard(input, before);
    try { const result = await (await this.client(input)).request(path, method, body, context.signal); this.access(input, context); return result; }
    catch (error) {
      if (!context.signal?.aborted && engineStopped(error) && currentCheck()) {
        this.repository.browsers.update(input, before.version, { state: "error" });
        this.healthStatus(input, "error", "电脑引擎已停止，请检查当前电脑后重新启动", "COMPUTER_DESKTOP_UNAVAILABLE"); this.emit(input, "browser", before.version);
      }
      throw failure(error);
    }
  }
  private async mutation(input: BrowserEpochInput & { clientNonce: string }, name: string, path: string, context: BrowserCallContext): Promise<unknown> {
    const id = this.intent(input, name, context); this.access(input, context); this.active.set(id, { scope: scope(input), ...(context.runtimeRunId ? { runtimeRunId: context.runtimeRunId } : {}) });
    this.repository.browsers.invalidateDesktopFrames(input, input.expectedEpoch, this.actor(context));
    try { return await this.request(input, path, "POST", this.wire(input, context, id), context); }
    catch (error) { if (context.signal?.aborted) await this.cancelOperation(scope(input), id).catch(() => undefined); throw failure(error); }
    finally { this.active.delete(id); }
  }
  async tabs(input: BrowserEpochInput, context: BrowserCallContext = {}): Promise<BrowserPage[]> {
    const parsed = schemas.browserEpochSchema.parse(input), query = new URLSearchParams({ actor: this.actor(context), expectedEpoch: String(parsed.expectedEpoch) });
    const values = z.array(schemas.browserPageSchema).max(50).parse(await this.request(parsed, `/v1/browser/pages?${query}`, "GET", undefined, context));
    const old = this.repository.browsers.pages(parsed, parsed.expectedEpoch, this.actor(context)); this.repository.browsers.upsertPages(parsed, values, parsed.expectedEpoch, this.actor(context));
    const current = this.repository.browsers.get(parsed)!;
    if (!current.activePageId && values[0]) this.repository.browsers.update(parsed, current.version, { activePageId: values[0].id });
    const semantic = (pages: BrowserPage[]) => JSON.stringify(pages.map(({ id, url, title, documentVersion }) => ({ id, url, title, documentVersion })).sort((a, b) => a.id.localeCompare(b.id)));
    if (semantic(old) !== semantic(values)) this.emit(parsed, "pages"); return values;
  }
  private page(input: BrowserEpochInput, raw: unknown, context: BrowserCallContext): BrowserPage {
    const value = schemas.browserPageSchema.parse(raw), expectedPage = (input as BrowserEpochInput & { pageId?: string }).pageId;
    if (expectedPage && expectedPage !== value.id) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
    const old = this.repository.browsers.pages(input, input.expectedEpoch, this.actor(context)).find(page => page.id === value.id);
    if (old && old.documentVersion > value.documentVersion) return old;
    const result = this.repository.browsers.upsertPage(input, value, input.expectedEpoch, this.actor(context));
    if (!old || old.documentVersion !== value.documentVersion || old.url !== value.url || old.title !== value.title) this.emit(input, "pages"); return result;
  }
  async newTab(input: BrowserMutationCall<BrowserNewTabInput>, context: BrowserCallContext = {}): Promise<BrowserPage> {
    const parsed = this.parseMutation(schemas.browserNewTabSchema, input, context); this.access(parsed, context, true); return this.page(parsed, await this.mutation(parsed, "newTab", "/v1/browser/pages", context), context);
  }
  async closeTab(input: BrowserMutationCall<BrowserPageMutationInput>, context: BrowserCallContext = {}): Promise<BrowserSession> {
    const parsed = this.parseMutation(schemas.browserPageMutationSchema, input, context); this.access(parsed, context, true);
    const result = z.object({ pageId: z.string().uuid(), closed: z.literal(true) }).strict().parse(await this.mutation(parsed, "closeTab", `/v1/browser/pages/${parsed.pageId}/close`, context));
    if (result.pageId !== parsed.pageId) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
    this.repository.browsers.removePage(parsed, parsed.pageId, parsed.expectedEpoch, this.actor(context)); this.emit(parsed, "pages"); return this.repository.browsers.get(parsed)!;
  }
  async navigate(input: BrowserMutationCall<BrowserNavigateInput>, context: BrowserCallContext = {}): Promise<BrowserPage> {
    const parsed = this.parseMutation(schemas.browserNavigateSchema, input, context); this.access(parsed, context, true); return this.page(parsed, await this.mutation(parsed, "navigate", `/v1/browser/pages/${parsed.pageId}/navigate`, context), context);
  }
  async observe(input: BrowserObserveInput, context: BrowserCallContext = {}) { return this.readObservation(schemas.browserObserveSchema.parse(input), "observe", context); }
  async read(input: BrowserReadInput, context: BrowserCallContext = {}) { return this.readObservation(schemas.browserReadSchema.parse(input), "read", context); }
  private async readObservation(input: BrowserObserveInput, method: string, context: BrowserCallContext) {
    const value = schemas.browserObservationSchema.parse(await this.request(input, `/v1/browser/pages/${input.pageId}/${method}`, "POST", this.wire(input, context), context));
    if (value.pageId !== input.pageId || value.controlEpoch !== input.expectedEpoch) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
    const previous = this.repository.browsers.pages(input, input.expectedEpoch, this.actor(context)).find(page => page.id === input.pageId);
    const at = value.observedAt;
    this.repository.browsers.upsertPage(input, { id: value.pageId, browserSessionId: value.browserSessionId, url: value.url, title: value.title, documentVersion: value.documentVersion, createdAt: previous?.createdAt ?? at, updatedAt: at }, input.expectedEpoch, this.actor(context));
    return this.repository.browsers.recordObservation(input, value, this.actor(context));
  }
  private async action<T extends BrowserActionInput>(schema: z.ZodType<T>, input: BrowserMutationCall<T>, family: "browser" | "computer", method: string, context: BrowserCallContext): Promise<BrowserPage> {
    const parsed = this.parseMutation(schema, input, context); this.access(parsed, context, true);
    const path = family === "browser" ? `/v1/browser/pages/${parsed.pageId}/${method}` : `/v1/computer/${method}`;
    return this.page(parsed, await this.mutation(parsed, `${family}.${method}`, path, context), context);
  }
  click(input: BrowserMutationCall<BrowserClickInput>, context: BrowserCallContext = {}) { return this.action(schemas.browserClickSchema, input, "browser", "click", context); }
  type(input: BrowserMutationCall<BrowserTypeInput>, context: BrowserCallContext = {}) { return this.action(schemas.browserTypeSchema, input, "browser", "type", context); }
  key(input: BrowserMutationCall<BrowserKeyInput>, context: BrowserCallContext = {}) { return this.action(schemas.browserKeySchema, input, "browser", "key", context); }
  scroll(input: BrowserMutationCall<BrowserScrollInput>, context: BrowserCallContext = {}) { return this.action(schemas.browserScrollSchema, input, "browser", "scroll", context); }
  private async desktopAction<T extends ComputerActionInput>(schema: z.ZodType<T>, input: BrowserMutationCall<T>, method: string, context: BrowserCallContext): Promise<ComputerActionResult> {
    const parsed = this.parseMutation(schema, input, context); this.access(parsed, context, true);
    const result = schemas.computerActionResultSchema.parse(await this.mutation(parsed, `computer.${method}`, `/v1/computer/${method}`, context));
    return "desktop" in result ? result : this.page(parsed, result, context);
  }
  computerClick(input: BrowserMutationCall<ComputerClickInput>, context: BrowserCallContext = {}) { return this.desktopAction(schemas.computerClickSchema, input, "click", context); }
  computerType(input: BrowserMutationCall<ComputerTypeInput>, context: BrowserCallContext = {}) { return this.desktopAction(schemas.computerTypeSchema, input, "type", context); }
  computerKey(input: BrowserMutationCall<ComputerKeyInput>, context: BrowserCallContext = {}) { return this.desktopAction(schemas.computerKeySchema, input, "key", context); }
  computerScroll(input: BrowserMutationCall<ComputerScrollInput>, context: BrowserCallContext = {}) { return this.desktopAction(schemas.computerScrollSchema, input, "scroll", context); }
  async computerWindows(input: BrowserEpochInput, context: BrowserCallContext = {}): Promise<DesktopWindow[]> {
    const parsed = schemas.browserEpochSchema.parse(input);
    return z.array(schemas.desktopWindowSchema).max(100).parse(await this.request(parsed, "/v1/computer/windows", "POST", this.wire(parsed, context), context));
  }
  computerFocusWindow(input: BrowserMutationCall<ComputerWindowInput>, context: BrowserCallContext = {}) { return this.desktopAction(schemas.computerWindowSchema, input, "focusWindow", context); }
  computerMove(input: BrowserMutationCall<ComputerClickInput>, context: BrowserCallContext = {}) { return this.desktopAction(schemas.computerClickSchema, input, "move", context); }
  computerMouseDown(input: BrowserMutationCall<ComputerButtonInput>, context: BrowserCallContext = {}) { return this.desktopAction(schemas.computerButtonSchema, input, "mouseDown", context); }
  computerMouseUp(input: BrowserMutationCall<ComputerButtonInput>, context: BrowserCallContext = {}) { return this.desktopAction(schemas.computerButtonSchema, input, "mouseUp", context); }
  computerDrag(input: BrowserMutationCall<ComputerDragInput>, context: BrowserCallContext = {}) { return this.desktopAction(schemas.computerDragSchema, input, "drag", context); }
  async computerScreenshot(input: ComputerScreenshotInput, context: BrowserCallContext = {}): Promise<ComputerScreenshot> {
    const parsed = schemas.computerScreenshotSchema.parse(input); const { frame, bytes } = verifiedFrame(await this.request(parsed, "/v1/computer/screenshot", "POST", this.wire(parsed, context), context));
    if (frame.controlEpoch !== parsed.expectedEpoch || frame.browserSessionId !== this.repository.browsers.get(parsed)!.id) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
    if (this.actor(context) === "ai" && !frame.pageId && !frame.desktop) throw new AevorenBotError("BROWSER_OBSERVATION_REQUIRED");
    if (frame.pageId) await this.tabs({ ...scope(parsed), expectedEpoch: parsed.expectedEpoch }, context);
    const blobPath = await this.media.put(bytes, frame.sha256, context.signal); this.access(parsed, context);
    const metadata = schemas.screenshotMediaSchema.parse({ ...Object.fromEntries(Object.entries(frame).filter(([key]) => key !== "dataBase64")), ...scope(parsed),
      id: randomUUID(), name: `screenshot.${frame.mimeType === "image/png" ? "png" : "jpg"}` });
    const media = this.repository.browsers.recordFrame(parsed, { ...metadata, blobPath }, this.actor(context));
    return { media, frame };
  }
  async imageAttachment(input: BrowserScope, id: string, expectedEpoch: number): Promise<ModelImageAttachment> {
    const record = this.repository.browsers.getFrame(input, id, expectedEpoch, "ai"); this.repository.browsers.assertFrame(input, id, expectedEpoch, "ai");
    const bytes = await this.media.read(record.blobPath, record.sha256, record.size);
    this.repository.browsers.assertFrame(input, id, expectedEpoch, "ai");
    return { reference: this.repository.browsers.assertFrame(input, id, expectedEpoch, "ai"), dataBase64: bytes.toString("base64"), isAuthorized: () => { try { this.repository.browsers.assertFrame(input, id, expectedEpoch, "ai"); return true; } catch { return false; } } };
  }
  async downloads(input: BrowserEpochInput, context: BrowserCallContext = {}): Promise<BrowserDownloadsPage> {
    const parsed = schemas.browserEpochSchema.parse(input), result = schemas.browserDownloadsPageSchema.parse(await this.request(parsed, "/v1/browser/downloads/list", "POST", this.wire(parsed, context), context));
    if (result.items.some(item => item.browserSessionId !== this.repository.browsers.get(parsed)!.id)) throw new AevorenBotError("BROWSER_SCOPE_INVALID"); return result;
  }
  async downloadData(input: BrowserMutationCall<BrowserDownloadInput>, context: BrowserCallContext = {}) {
    const parsed = this.parseMutation(schemas.browserDownloadInputSchema, input, context);
    const value = schemas.browserWorkerDownloadSchema.parse(await this.request(parsed, `/v1/browser/downloads/${parsed.id}/content`, "POST", { actor: this.actor(context), expectedEpoch: parsed.expectedEpoch }, context));
    if (value.id !== parsed.id || value.browserSessionId !== this.repository.browsers.get(parsed)!.id) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
    const bytes = Buffer.from(value.dataBase64, "base64"); if (createHash("sha256").update(bytes).digest("hex") !== value.sha256) throw new AevorenBotError("BROWSER_MEDIA_INVALID");
    const metadata = schemas.browserDownloadSchema.parse(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "dataBase64"))); const blobPath = await this.media.put(bytes, value.sha256, context.signal); this.access(parsed, context);
    this.repository.browsers.recordDownload(parsed, metadata, blobPath, parsed.expectedEpoch, this.actor(context)); return { download: metadata, bytes };
  }
  private async control(input: BrowserMutationCall<ComputerControlInput>, owner: ComputerOwner, context: BrowserCallContext): Promise<ComputerView> {
    const parsed = this.parseMutation(schemas.computerControlSchema, input, context); if (this.actor(context) !== "user") throw new AevorenBotError("COMPUTER_USER_CONTROLLED");
    return this.locked(parsed, async () => {
      this.live(parsed, context); const id = this.intent(parsed, `control.${owner}`, context), before = this.repository.browsers.get(parsed)!;
      let intent = this.controls.get(id);
      if (!intent) { const claimed = this.repository.browsers.claimControl(parsed, { owner: "user", expectedEpoch: parsed.expectedEpoch, ...(parsed.expectedVersion ? { expectedVersion: parsed.expectedVersion } : {}) });
        intent = { scope: scope(parsed), owner, previousEpoch: parsed.expectedEpoch, claimedEpoch: claimed.epoch, bootId: before.bootId }; this.controls.set(id, intent); this.viewers.revoke(parsed); this.emit(parsed, "control", before.version); }
      if (intent.owner !== owner || intent.previousEpoch !== parsed.expectedEpoch) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
      const currentView = this.repository.browsers.view(parsed)!;
      if (intent.completedEpoch !== undefined) {
        if (currentView.epoch !== intent.completedEpoch || currentView.owner !== intent.owner || this.repository.browsers.get(parsed)!.bootId !== intent.bootId) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
        const actual = await this.health(parsed, context.signal); this.live(parsed, context);
        if (actual.control.controlEpoch !== intent.completedEpoch || actual.control.owner !== intent.owner || actual.bootId !== intent.bootId) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
        return this.repository.browsers.view(parsed)!;
      }
      if (currentView.epoch !== intent.claimedEpoch || currentView.owner !== "user") throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
      try {
        // An explicit human return must also work after the old desktop stopped.
        // Recover only its owned container; keep the host sealed until the Worker
        // confirms the return at a fresh epoch. Never infer a return from disconnect.
        if (owner === "ai" && before.state === "stopped") {
          const saved = this.repository.browsers.getInternal(parsed)!;
          const stopped = await this.docker.inspectBrowser(saved.id, saved.environmentId, context.signal);
          if (!stopped || stopped.id !== saved.containerId || stopped.imageId !== saved.imageDigest) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
          if (!["created", "exited"].includes(stopped.state)) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
          const restarted = await this.docker.startBrowser(saved.id, saved.environmentId, context.signal);
          if (restarted.id !== stopped.id || restarted.imageId !== stopped.imageId) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
          this.repository.browsers.updateConnection(parsed, { workerPort: restarted.workerPort });
          await (await this.client(parsed)).waitHealthy(context.signal, 50_000);
          intent.bootId = (await this.health(parsed, context.signal)).bootId;
        }
        // The host has already claimed user ownership, so no new AI request can enter.
        // Pause commands and settle the computer task before opening a human input lease.
        if (owner === "user") {
          await this.environments.pauseAutomation(scope(parsed), true, context.signal);
          await this.controlLifecycle?.(scope(parsed), "user");
        }
        let health = await this.health(parsed, context.signal);
        if (health.bootId !== intent.bootId || health.control.controlEpoch > intent.claimedEpoch) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
        while (health.control.controlEpoch < intent.claimedEpoch || health.control.owner !== owner
          || health.bootId !== before.bootId && health.control.controlEpoch === intent.claimedEpoch) {
          const expectedEpoch = health.control.controlEpoch;
          const result = schemas.browserWorkerControlSchema.parse(await (await this.client(parsed)).request(`/v1/computer/${owner === "user" ? "takeover" : "return"}`, "POST",
            { actor: "user", expectedEpoch, operationId: operationId(`${id}:${owner}:${expectedEpoch}`) }, context.signal));
          if (result.controlEpoch <= expectedEpoch) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
          health = await this.health(parsed, context.signal);
        }
        this.live(parsed, context); if (health.control.owner !== owner) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED");
        if (owner === "ai") {
          try {
            await this.environments.pauseAutomation(scope(parsed), false, context.signal);
            await this.environments.reconcileBinding(scope(parsed), context.signal);
          } catch (error) {
            // A failed return still belongs to the person. Do not leave old
            // commands running just because Docker resumed before health failed.
            await this.environments.pauseAutomation(scope(parsed), true);
            throw error;
          }
        }
        this.repository.browsers.syncControl(parsed, health.control, health.bootId, { explicitReturn: owner === "ai" });
        this.repository.browsers.update(parsed, this.repository.browsers.get(parsed)!.version, { state: "running" }); intent.completedEpoch = health.control.controlEpoch;
        this.emit(parsed, "control", before.version);
        if (owner === "ai") await this.controlLifecycle?.(scope(parsed), "ai");
        return this.repository.browsers.view(parsed)!;
      } catch (error) { this.repository.browsers.update(parsed, this.repository.browsers.get(parsed)!.version, { state: "unknown" }); throw failure(error); }
    });
  }
  takeover(input: BrowserMutationCall<ComputerControlInput>, context: BrowserCallContext = {}) { return this.control(input, "user", context); }
  returnControl(input: BrowserMutationCall<ComputerControlInput>, context: BrowserCallContext = {}) { return this.control(input, "ai", context); }
  async vncTicket(input: BrowserEpochInput & { clientNonce?: string }, context: BrowserCallContext = {}): Promise<ComputerVncTicket> {
    if (this.actor(context) !== "user") throw new AevorenBotError("COMPUTER_USER_CONTROLLED");
    const parsed = this.parseMutation(schemas.computerVncTicketSchema, input, context);
    return this.locked(parsed, async () => {
      this.access(parsed, context, true); const id = this.intent(parsed, "vncTicket", context), previous = this.ticketResults.get(id);
      if (previous) { if (previous.epoch !== parsed.expectedEpoch || Date.parse(previous.expiresAt) <= Date.now()) throw new AevorenBotError("COMPUTER_CONTROL_CHANGED"); return previous; }
      const record = this.repository.browsers.getInternal(parsed)!;
      const ticket = await this.viewers.ticket({ scope: scope(parsed), browserSessionId: record.id, epoch: parsed.expectedEpoch, port: record.workerPort!, token: this.codec.decrypt(record.encryptedToken!),
        isAuthorized: () => { try { return this.repository.browsers.assertFresh(parsed, parsed.expectedEpoch, "user").owner === "user"; } catch { return false; } } });
      this.access(parsed, context, true); this.ticketResults.set(id, ticket); return ticket;
    });
  }
  async previewList(input: BrowserEpochInput, context: BrowserCallContext = {}): Promise<ServicePreview[]> {
    const parsed = schemas.browserEpochSchema.parse(input); this.access(parsed, context); const ports = await this.environments.listPorts(scope(parsed)); this.access(parsed, context);
    const previous = this.repository.browsers.listPreviews(parsed, parsed.expectedEpoch, this.actor(context));
    for (const item of previous.filter(item => item.state !== "closed")) {
      const port = ports.find(port => port.id === item.registeredPortId && port.state === "listening");
      let valid = Boolean(port);
      if (port) { try { await this.environments.createPreview(scope(parsed), item.id, item.registeredPortId, context.signal); } catch { valid = false; } }
      this.access(parsed, context);
      if (!valid) this.repository.browsers.closePreview(parsed, item.id, parsed.expectedEpoch, this.actor(context));
    }
    return this.repository.browsers.listPreviews(parsed, parsed.expectedEpoch, this.actor(context));
  }
  async previewOpen(input: BrowserMutationCall<PreviewOpenInput>, context: BrowserCallContext = {}): Promise<ServicePreview> {
    const parsed = this.parseMutation(schemas.previewOpenSchema, input, context); this.access(parsed, context, true);
    const ports = await this.environments.listPorts(scope(parsed)); this.access(parsed, context); const port = ports.find(port => port.id === parsed.registeredPortId && port.state === "listening");
    if (!port) throw new AevorenBotError("PREVIEW_UNAVAILABLE"); const current = this.repository.browsers.get(parsed)!;
    const id = operationId(`${this.intent(parsed, "preview.open", context)}:preview`);
    const previous = this.repository.browsers.listPreviews(parsed, parsed.expectedEpoch, this.actor(context)).find(item => item.id === id);
    if (previous) {
      if (previous.registeredPortId !== parsed.registeredPortId) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
      if (previous.state !== "closed") await this.environments.createPreview(scope(parsed), id, port.id, context.signal);
      this.access(parsed, context);
      await this.tabs({ ...scope(parsed), expectedEpoch: parsed.expectedEpoch }, context);
      return this.repository.browsers.listPreviews(parsed, parsed.expectedEpoch, this.actor(context)).find(item => item.id === id)!;
    }
    const ticket = schemas.executionPreviewTicketSchema.parse(await this.environments.createPreview(scope(parsed), id, port.id, context.signal));
    if (ticket.id !== id || ticket.registeredPortId !== port.id || ticket.processId !== port.processId || ticket.port !== port.port || !ticket.host.endsWith(`.aevoren-preview-${current.environmentId}.internal`) || Date.parse(ticket.expiresAt) <= Date.now()) throw new AevorenBotError("PREVIEW_UNAVAILABLE");
    this.access(parsed, context); const url = `http://${ticket.host}:8080/`;
    const page = await this.newTab({ ...scope(parsed), expectedEpoch: parsed.expectedEpoch, clientNonce: parsed.clientNonce, url }, { ...context, operationId: this.intent(parsed, "preview.open", context) });
    this.access(parsed, context); const preview = this.repository.browsers.recordPreview(parsed, { registeredPortId: port.id, pageId: page.id, url, id }, parsed.expectedEpoch, this.actor(context)); this.emit(parsed, "preview"); return preview;
  }
  async previewClose(input: BrowserMutationCall<PreviewCloseInput>, context: BrowserCallContext = {}): Promise<ServicePreview> {
    const parsed = this.parseMutation(schemas.previewCloseSchema, input, context); this.access(parsed, context, true);
    const preview = this.repository.browsers.listPreviews(parsed, parsed.expectedEpoch, this.actor(context)).find(value => value.id === parsed.id);
    if (!preview) throw new AevorenBotError("PREVIEW_NOT_FOUND");
    await this.environments.closePreview(scope(parsed), parsed.id); this.access(parsed, context);
    if (preview.state !== "closed") await this.closeTab({ ...scope(parsed), expectedEpoch: parsed.expectedEpoch, pageId: preview.pageId, clientNonce: parsed.clientNonce }, context);
    return this.repository.browsers.closePreview(parsed, parsed.id, parsed.expectedEpoch, this.actor(context));
  }
  async releaseInput(input: BrowserScope): Promise<void> {
    const view = this.repository.browsers.view(input), record = this.repository.browsers.get(input);
    if (!view || view.owner !== "ai" || record?.state !== "running") return;
    await (await this.client(input)).request("/v1/computer/release-input", "POST", { actor: "ai", expectedEpoch: view.epoch });
  }
  private async cancelOperation(input: BrowserScope, id: string) { return schemas.browserWorkerCancelAckSchema.parse(await (await this.client(input)).request(`/v1/operations/${id}/cancel`, "POST", {})); }
  async cancelRuntime(runtimeRunId: string): Promise<void> { await Promise.allSettled([...this.active].filter(([, entry]) => entry.runtimeRunId === runtimeRunId).map(([id, entry]) => this.cancelOperation(entry.scope, id))); }
  async release(input: BrowserScope, remove = false): Promise<void> {
    this.healthChecks.set(`${input.sessionId}:${input.executorBotId}`, Symbol());
    this.startupRequests.get(`${input.sessionId}:${input.executorBotId}`)?.controller.abort();
    await this.stopLifecycle?.(scope(input), remove);
    return this.locked(input, async () => { const record = this.repository.browsers.getInternal(input); if (!record) return;
    this.viewers.revoke(input); await this.docker.stopBrowser(record.id, record.environmentId, remove); const current = this.repository.browsers.get(input);
    if (current) {
      if (remove) this.repository.browsers.updateConnection(input, { imageDigest: null, imageRef: null, workerVersion: null, platform: null, workerPort: null, containerId: null });
      this.repository.browsers.update(input, this.repository.browsers.get(input)!.version, { state: "stopped" });
      this.healthStatus(input, "stopped", "电脑已停止，工作文件仍保留", "BROWSER_UNAVAILABLE");
    }
  }); }
  async shutdown(): Promise<void> { this.closing = true; this.startupClosing.abort(); this.demonstrationClosing.abort(); await Promise.allSettled([...this.startupRequests.values()].map(value => value.promise)); await Promise.allSettled(this.demonstrationPending); await Promise.allSettled([...this.active].map(([id, entry]) => this.cancelOperation(entry.scope, id))); await this.viewers.shutdown(); }
}
