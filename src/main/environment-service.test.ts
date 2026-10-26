import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_WORKER_VERSION, WORKER_AUTOMATION_PAUSE_CAPABILITY, type EnvironmentScope } from "@shared/environment-contracts";
import { AppRepository } from "./database";
import { DockerDriver, EXECUTION_IMAGE_REF, type DockerImage } from "./docker-driver";
import { EnvironmentService } from "./environment-service";
import { ExecutionWorkerClient, ExecutionWorkerError } from "./execution-worker-client";
import { apiResult } from "./errors";

const repositories: AppRepository[] = [];
const directories: string[] = [];
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-environment-admission-"));
  directories.push(directory);
  const repository = new AppRepository(join(directory, "app.sqlite"));
  repositories.push(repository);
  // Real context files are hashed by the service; this fixture never executes their code.
  const files = {
    "index.mjs": Buffer.from('// Admission fixture only.\nprocess.stdout.write("fixture worker");\n'),
    "file-helper.mjs": Buffer.from('// Admission fixture only.\nprocess.stdout.write("fixture helper");\n'),
    Dockerfile: readFileSync(resolve("workers/execution/Dockerfile")),
  };
  const hash = createHash("sha256");
  for (const [name, bytes] of Object.entries(files)) { writeFileSync(join(directory, name), bytes); hash.update(name); hash.update(bytes); }
  const image: DockerImage = { id: `sha256:${"a".repeat(64)}`, ref: EXECUTION_IMAGE_REF, platform: "linux/arm64", workerVersion: ENV_WORKER_VERSION, bundleSha256: hash.digest("hex") };
  const configuration = { workerVersion: image.workerVersion, imageRef: image.ref, imageDigest: image.id, platform: image.platform };
  const driver = new DockerDriver();
  const service = new EnvironmentService(repository.environments, { isAvailable: () => true, encrypt: value => value, decrypt: value => value }, directory, () => undefined, driver);
  return { repository, service, driver, image, configuration };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const repository of repositories.splice(0)) repository.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("environment lifecycle admission with real SQLite", () => {
  function controlFixture() {
    const f = fixture(), owner = f.repository.createBot(), scope = { sessionId: owner.session.id, executorBotId: owner.bot.id };
    const record = f.repository.environments.ensure(scope, f.configuration);
    f.repository.environments.update(scope, record.version, { state: "running", containerId: "owned-container", encryptedToken: "a".repeat(64), workerPort: 45001 });
    vi.spyOn(f.driver, "inspect").mockResolvedValue({ id: "owned-container", imageId: f.image.id, name: "controlled", state: "running", workerPort: 45001, oomKilled: false, layoutVersion: 2 });
    const health = vi.spyOn(ExecutionWorkerClient.prototype, "health").mockResolvedValue({ environmentId: record.id, bootId: randomUUID(), workerVersion: ENV_WORKER_VERSION, protocolVersion: 1, capabilities: [WORKER_AUTOMATION_PAUSE_CAPABILITY] });
    const pause = vi.spyOn(f.driver, "pauseAutomation").mockRejectedValue(new Error("The cancellation channel must remain reachable"));
    const request = vi.spyOn(ExecutionWorkerClient.prototype, "request").mockImplementation(async (_path, _method, input) => input);
    return { ...f, scope, health, pause, request };
  }
  it("pauses foreground automation through the authenticated Worker without freezing its control channel", async () => {
    const f = controlFixture();
    await f.service.pauseAutomation(f.scope, true);
    await f.service.pauseAutomation(f.scope, false);
    expect(f.request.mock.calls.map(([path, method, input]) => ({ path, method, input }))).toEqual([
      { path: "/v1/automation/control", method: "POST", input: { paused: true } },
      { path: "/v1/automation/control", method: "POST", input: { paused: false } },
    ]);
    expect(f.pause).not.toHaveBeenCalled();
  });
  it("refuses an unsupported or unconfirmed pause before opening human input", async () => {
    const f = controlFixture(), health = await f.health.getMockImplementation()!();
    f.health.mockResolvedValue({ ...health, capabilities: [] });
    await expect(f.service.pauseAutomation(f.scope, true)).rejects.toMatchObject({ code: "ENVIRONMENT_IMAGE_INVALID" });
    expect(f.request).not.toHaveBeenCalled(); expect(f.pause).not.toHaveBeenCalled();
    f.health.mockResolvedValue(health); f.request.mockResolvedValue({ paused: false });
    await expect(f.service.pauseAutomation(f.scope, true)).rejects.toMatchObject({ code: "ENVIRONMENT_UNAVAILABLE" });
    f.request.mockResolvedValue({ paused: true, unconfirmed: true });
    await expect(f.service.pauseAutomation(f.scope, true)).rejects.toThrow();
  });
  it("reconnects human-owned desktop metadata without querying or unpausing its frozen execution Worker", async () => {
    const f = fixture(), owner = f.repository.createBot(), scope = { sessionId: owner.session.id, executorBotId: owner.bot.id };
    const record = f.repository.environments.ensure(scope, f.configuration);
    f.repository.environments.update(scope, record.version, { state: "running", containerId: "owned-container", encryptedToken: "private-token", workerPort: 45000 });
    vi.spyOn(f.driver, "inspect").mockResolvedValue({ id: "owned-container", imageId: f.image.id, name: "controlled", state: "paused", workerPort: 45001, oomKilled: false, layoutVersion: 2 });
    const health = vi.spyOn(ExecutionWorkerClient.prototype, "health").mockRejectedValue(new Error("A frozen Worker must not be contacted"));
    const pause = vi.spyOn(f.driver, "pauseAutomation");
    await expect(f.service.reconcileBinding(scope)).rejects.toMatchObject({ code: "ENVIRONMENT_UNAVAILABLE" });
    await expect(f.service.reconcileBinding(scope, undefined, true)).resolves.toMatchObject({ state: "running" });
    expect(f.repository.environments.getInternal(scope)?.workerPort).toBe(45001);
    for (const state of ["unknown", "stopped"] as const) {
      const current = f.repository.environments.get(scope)!;
      f.repository.environments.update(scope, current.version, { state });
      expect(await f.service.get(scope)).toMatchObject({ state: "running" });
    }
    vi.mocked(f.driver.inspect).mockResolvedValue({ id: "owned-container", imageId: f.image.id, name: "controlled", state: "paused", workerPort: null, oomKilled: false, layoutVersion: 2 });
    await expect(f.service.reconcileBinding(scope, undefined, true)).resolves.toMatchObject({ state: "running" });
    expect(f.repository.environments.getInternal(scope)?.workerPort).toBe(45001);
    expect(health).not.toHaveBeenCalled(); expect(pause).not.toHaveBeenCalled();
  });
  it("refuses a first scope's delayed start after its Bot enters retirement before ensure", async () => {
    const f = fixture();
    const owner = f.repository.createBot(), peer = f.repository.createBot();
    const room = f.repository.createRoom({ memberBotIds: [owner.bot.id, peer.bot.id] });
    const privateScope = { sessionId: owner.session.id, executorBotId: owner.bot.id };
    const newScope = { sessionId: room.session.id, executorBotId: owner.bot.id };
    const siblingScope = { sessionId: room.session.id, executorBotId: peer.bot.id };
    const original = f.repository.environments.ensure(privateScope, f.configuration);
    const sibling = f.repository.environments.ensure(siblingScope, f.configuration);
    const imageEntered = deferred<void>(), imageReady = deferred<DockerImage | null>();
    const stopEntered = deferred<void>(), stopReady = deferred<void>();
    vi.spyOn(f.driver, "inspectImage").mockImplementation(async () => { imageEntered.resolve(); return imageReady.promise; });
    const stop = vi.spyOn(f.driver, "stop").mockImplementation(async id => {
      expect(id).toBe(original.id); stopEntered.resolve(); await stopReady.promise;
    });
    const remove = vi.spyOn(f.driver, "remove").mockResolvedValue();
    vi.spyOn(f.driver, "inspect").mockResolvedValue(null);
    const create = vi.spyOn(f.driver, "create").mockRejectedValue(new Error("A retired scope must never reach container creation"));
    const pending = f.service.start(newScope);
    await imageEntered.promise;
    expect(f.repository.environments.get(newScope)).toBeNull();
    const retirement = f.service.retire([], [owner.bot.id], () => f.repository.assertBotDeletable(owner.bot.id), () => f.repository.deleteBot(owner.bot.id));
    await stopEntered.promise;
    const refused = expect(pending).rejects.toMatchObject({ code: "ENVIRONMENT_SCOPE_INVALID" });
    imageReady.resolve(f.image);
    try {
      await refused;
      expect(create).not.toHaveBeenCalled();
      expect(f.repository.environments.get(newScope)).toBeNull();
    } finally { stopReady.resolve(); await retirement; }
    expect(stop).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(original.id);
    expect(f.repository.environments.listInternal().map(environment => environment.id)).toEqual([sibling.id]);
    expect(f.repository.environments.get(siblingScope)).toEqual(sibling);
  });

  it("isolates a legacy revoked scope during recovery and shutdown without cancelling background records", async () => {
    const f = fixture();
    const bots = Array.from({ length: 3 }, () => f.repository.createBot());
    const room = f.repository.createRoom({ memberBotIds: bots.map(bot => bot.bot.id) });
    const revokedScope = { sessionId: room.session.id, executorBotId: bots[0]!.bot.id };
    const liveScope = { sessionId: room.session.id, executorBotId: bots[1]!.bot.id };
    function pendingTask(scope: EnvironmentScope, kind: "foreground" | "background") {
      f.repository.environments.ensure(scope, f.configuration);
      const session = f.repository.environments.createSession(scope, null);
      return f.repository.environments.createExecution(scope, { executionSessionId: session.id, clientNonce: randomUUID(), kind, command: `unconfirmed ${kind}` }).execution;
    }
    const revoked = pendingTask(revokedScope, "foreground");
    const foreground = pendingTask(liveScope, "foreground");
    const background = pendingTask(liveScope, "background");
    // Seed the pre-fix shape: real membership revocation with an old environment row retained.
    const oldCleanup = vi.spyOn(f.repository.environments, "deleteScope").mockReturnValueOnce(0);
    f.repository.removeRoomMember(room.room.id, revokedScope.executorBotId, room.room.membershipVersion);
    oldCleanup.mockRestore();
    expect(f.repository.environments.listInternal().some(environment => environment.id === revoked.environmentId)).toBe(true);
    expect(() => f.repository.environments.get(revokedScope)).toThrow();
    const inspect = vi.spyOn(f.driver, "inspect").mockResolvedValue(null);
    const cancel = vi.spyOn(f.service, "cancel");
    await expect(f.service.recover()).resolves.toBeUndefined();
    await expect(f.service.shutdown()).resolves.toBeUndefined();
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls.map(([input]) => input.id)).toEqual([foreground.id, foreground.id]);
    expect(cancel.mock.calls.every(([input]) => input.sessionId === liveScope.sessionId && input.executorBotId === liveScope.executorBotId)).toBe(true);
    expect(f.repository.environments.getExecution(liveScope, background.id)).toEqual(background);
    expect(f.repository.environments.getExecution(liveScope, foreground.id).state).toBe("unknown");
  });
});

describe("environment file error boundaries with real SQLite", () => {
  function fileFixture() {
    const f = fixture(), owner = f.repository.createBot(), scope = { sessionId: owner.session.id, executorBotId: owner.bot.id };
    const environment = f.repository.environments.ensure(scope, f.configuration);
    f.repository.environments.update(scope, environment.version, { state: "running", workerPort: 41321, encryptedToken: "a".repeat(64) });
    const request = vi.spyOn(ExecutionWorkerClient.prototype, "request");
    return { ...f, scope, request };
  }
  const operations = ["read", "list", "write"] as const;
  function operate(f: ReturnType<typeof fileFixture>, operation: typeof operations[number]): Promise<unknown> {
    if (operation === "list") return f.service.listFiles({ ...f.scope, path: "nested" });
    if (operation === "read") return f.service.readFile({ ...f.scope, path: "nested/file.txt" });
    return f.service.writeFile({ ...f.scope, path: "nested/file.txt", content: "new content", expectedSha256: "b".repeat(64) });
  }

  it.each([
    ["WORKER_FILE_NOT_FOUND", 404, "ENVIRONMENT_FILE_NOT_FOUND", "storage"],
    ["WORKER_FILE_ACCESS_DENIED", 403, "ENVIRONMENT_FILE_ACCESS_DENIED", "security"],
    ["WORKER_PATH_INVALID", 400, "ENVIRONMENT_FILE_INVALID", "security"],
    ["WORKER_INVALID_REQUEST", 400, "ENVIRONMENT_FILE_INVALID", "security"],
    ["WORKER_FILE_CONFLICT", 409, "ENVIRONMENT_FILE_CONFLICT", "storage"],
    ["WORKER_FILE_CHANGED", 409, "ENVIRONMENT_FILE_CONFLICT", "storage"],
    ["WORKER_FILE_TOO_LARGE", 413, "ENVIRONMENT_FILE_TOO_LARGE", "validation"],
    ["WORKER_REQUEST_TOO_LARGE", 413, "ENVIRONMENT_FILE_TOO_LARGE", "validation"],
    ["WORKER_FILE_FAILED", 503, "ENVIRONMENT_UNAVAILABLE", "tool"],
    ["WORKER_CONNECTION_FAILED", undefined, "ENVIRONMENT_UNAVAILABLE", "tool"],
    ["WORKER_RESPONSE_INVALID", 502, "ENVIRONMENT_UNAVAILABLE", "tool"],
    ["WORKER_ROUTE_NOT_FOUND", 404, "ENVIRONMENT_UNAVAILABLE", "tool"],
    ["WORKER_IDEMPOTENCY_CONFLICT", 409, "ENVIRONMENT_UNAVAILABLE", "tool"],
    ["WORKER_INTERNAL_ERROR", 500, "ENVIRONMENT_UNAVAILABLE", "tool"],
    ["WORKER_UNAUTHORIZED", 401, "ENVIRONMENT_UNAVAILABLE", "tool"],
  ] as const)("normalizes %s for read/list/write without command-status fallback or replay", async (workerCode, status, code, domain) => {
    const f = fileFixture(), error = new ExecutionWorkerError(workerCode, status);
    error.message = "/host/private/file private-token RAW_WORKER_ERROR";
    f.request.mockRejectedValue(error);
    for (const operation of operations) {
      f.request.mockClear();
      const result = await apiResult(() => operate(f, operation));
      expect(result).toMatchObject({ ok: false, error: { code, domain, retryable: false } });
      expect(JSON.stringify(result)).not.toMatch(/\/host\/private|private-token|RAW_WORKER_ERROR|WORKER_/u);
      expect(f.request).toHaveBeenCalledTimes(1);
    }
    expect(f.repository.environments.listExecutions(f.scope)).toEqual([]);
  });

  it("keeps the authenticated file protocol and digest-guarded replacement request", async () => {
    const f = fileFixture(), content = "new content", sha256 = createHash("sha256").update(content).digest("hex");
    f.request.mockResolvedValueOnce({ path: "nested", entries: [{ path: "nested/file.txt", type: "file", size: Buffer.byteLength(content), modifiedAt: new Date().toISOString() }], truncated: false })
      .mockResolvedValueOnce({ path: "nested/file.txt", content, size: Buffer.byteLength(content), sha256, mimeType: "text/plain", encoding: "utf8" })
      .mockResolvedValueOnce({ path: "nested/file.txt", size: Buffer.byteLength(content), sha256 });
    for (const operation of ["list", "read", "write"] as const) await operate(f, operation);
    expect(f.request.mock.calls).toEqual([
      ["/v1/files?path=nested"],
      ["/v1/files/content?path=nested%2Ffile.txt"],
      ["/v1/files/content?path=nested%2Ffile.txt", "PUT", { path: "nested/file.txt", content, encoding: "utf8", expectedSha256: "b".repeat(64) }, undefined],
    ]);
  });

  it("rejects malformed file results and unverified digests without repeating the operation", async () => {
    const f = fileFixture();
    for (const [operation, response] of [
      ["list", { path: "nested", entries: [{ path: "../private", type: "file", size: 0, modifiedAt: new Date().toISOString() }], truncated: false }],
      ["read", { path: "nested/file.txt", content: "unverified", size: 10, sha256: "a".repeat(64), mimeType: "text/plain", encoding: "utf8" }],
      ["read", { path: "nested/file.txt", content: "missing fields" }],
      ["write", { path: "nested/file.txt", size: 11, sha256: "a".repeat(64) }],
    ] as const) {
      f.request.mockClear(); f.request.mockResolvedValue(response);
      expect(await apiResult(() => operate(f, operation))).toMatchObject({ ok: false, error: { code: "ENVIRONMENT_FILE_INVALID", retryable: false } });
      expect(f.request).toHaveBeenCalledTimes(1);
    }
  });

  it("preserves scope denial and rejects unsafe input before contacting the Worker", async () => {
    const f = fileFixture(), peer = f.repository.createBot(), peerScope = { sessionId: peer.session.id, executorBotId: f.scope.executorBotId };
    for (const operation of operations) {
      const isolated = { ...f, scope: peerScope };
      expect(await apiResult(() => operate(isolated, operation))).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    }
    expect(await apiResult(() => f.service.readFile({ ...f.scope, path: "../private" }))).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(await apiResult(() => f.service.listFiles({ ...f.scope, path: "../private" }))).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(await apiResult(() => f.service.writeFile({ ...f.scope, path: "../private", content: "unsafe" }))).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("does not retry a write after its acknowledgement is lost or cancellation occurs", async () => {
    const f = fileFixture(), controller = new AbortController();
    f.request.mockImplementation(async () => { controller.abort(); throw new ExecutionWorkerError("WORKER_CONNECTION_FAILED"); });
    expect(await apiResult(() => f.service.writeFile({ ...f.scope, path: "file.txt", content: "uncertain" }, controller.signal))).toMatchObject({ ok: false, error: { code: "TOOL_EXECUTION_CANCELLED" } });
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});

describe("environment port registration error boundaries with real SQLite", () => {
  function backgroundFixture() {
    const f = fixture(), owner = f.repository.createBot(), scope = { sessionId: owner.session.id, executorBotId: owner.bot.id };
    const environment = f.repository.environments.ensure(scope, f.configuration);
    f.repository.environments.update(scope, environment.version, { state: "running", workerPort: 41321, encryptedToken: "a".repeat(64) });
    const session = f.repository.environments.createSession(scope, null);
    const process = f.repository.environments.createExecution(scope, { executionSessionId: session.id, clientNonce: randomUUID(), kind: "background", command: "unconfirmed background service" }).execution;
    return { ...f, scope, process };
  }

  it("reports the Worker's missing or wrong-owner listener without publishing a port or bypassing process scope", async () => {
    const f = backgroundFixture();
    const request = vi.spyOn(ExecutionWorkerClient.prototype, "request").mockRejectedValue(new ExecutionWorkerError("WORKER_PORT_NOT_OWNED", 409));
    expect(await apiResult(() => f.service.registerPort({ ...f.scope, processId: f.process.id, port: 8127 }))).toMatchObject({ ok: false, error: {
      code: "ENVIRONMENT_PORT_NOT_FOUND", safeMessage: "后台服务尚未监听该端口，或端口不属于所选进程。请先查看服务日志并确认启动完成。",
    } });
    expect(f.repository.environments.listPorts(f.scope)).toEqual([]);
    const peer = f.repository.createBot(), peerScope = { sessionId: peer.session.id, executorBotId: peer.bot.id };
    f.repository.environments.ensure(peerScope, f.configuration); request.mockClear();
    await expect(f.service.registerPort({ ...peerScope, processId: f.process.id, port: 8127 })).rejects.toMatchObject({ code: "ENVIRONMENT_EXECUTION_NOT_FOUND" });
    expect(request).not.toHaveBeenCalled();
  });

  it("normalizes other Worker connection failures without misreporting a missing listener", async () => {
    const f = backgroundFixture();
    vi.spyOn(ExecutionWorkerClient.prototype, "request").mockRejectedValue(new ExecutionWorkerError("WORKER_CONNECTION_FAILED"));
    expect(await apiResult(() => f.service.registerPort({ ...f.scope, processId: f.process.id, port: 8127 }))).toMatchObject({ ok: false, error: { code: "ENVIRONMENT_UNAVAILABLE" } });
    expect(f.repository.environments.listPorts(f.scope)).toEqual([]);
  });
});
