import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ModelEvent, ModelProvider, ChatMessage } from "./model";
import type { ModelImageAttachment } from "./model-image";
import type { ComputerToolGateway, ComputerToolResult } from "./computer-tool-gateway";
import { AppRepository } from "./database";
import { ComputerTaskService } from "./computer-task-service";
import { addComputerTaskProductHandlers } from "./computer-task-product-handlers";
import { AevorenBotError } from "./errors";

const repositories: AppRepository[] = [], services: ComputerTaskService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const repository of repositories.splice(0)) repository.close(); });
const selection = { providerInstanceId: "openai-compatible.default", modelId: "controlled-computer-model" };
const event = (operation: string, input?: unknown): ModelEvent => ({ type: "project-tool", toolCallId: randomUUID(), tool: { kind: "product-call", action: "execute", operation, input } });
function observation(messages: ChatMessage[]): string {
  const message = messages.toReversed().find(message => message.role === "tool" && message.images?.length);
  return ((message as Extract<ChatMessage, { role: "tool" }>).images![0]!.reference as { observationId?: string }).observationId!;
}
function frame(): ComputerToolResult {
  const id = randomUUID(), media = { id: randomUUID(), observationId: id, name: "controlled.png", mimeType: "image/png", size: 1, sha256: "a".repeat(64) };
  const image: ModelImageAttachment = { reference: media, dataBase64: "AA==", isAuthorized: () => true };
  return { result: { media }, images: [image] };
}
function fixture(run: ModelProvider["run"]) {
  const repository = new AppRepository(":memory:"); repositories.push(repository);
  const owner = repository.createBot(), scope = { sessionId: owner.session.id, executorBotId: owner.bot.id };
  const provider: ModelProvider = { run, testConnection: async () => {} };
  let version = 1, human = false;
  const providers = { isSupported: () => true, createProvider: vi.fn(() => provider), getCapabilities: () => ({ toolImageInput: true }),
    get: async () => ({ id: selection.providerInstanceId, version, status: "available" }) };
  const gateway: ComputerToolGateway = { definitions: [{ name: "computer.screenshot", channel: "computer:screenshot", description: "Controlled real-frame protocol fixture", effectClass: "read-local", interaction: "none" }, { name: "computer.click", channel: "computer:click", description: "Controlled fixture", effectClass: "irreversible", interaction: "none" }],
    schemas: { "computer.screenshot": z.object({}).strict(), "computer.click": z.object({}).strict() }, assertAI: () => { if (human) throw new AevorenBotError("COMPUTER_USER_CONTROLLED"); },
    prepare: vi.fn(async () => frame()), execute: vi.fn(async (_task, operation) => { const shot = frame(); return operation === "computer.screenshot" ? shot : { result: { action: "performed", feedback: shot.result }, images: shot.images }; }), cancel: vi.fn(async () => {}) };
  const service = new ComputerTaskService(repository, providers as never, gateway, undefined, async () => {}); services.push(service);
  service.saveConfiguration({ expectedVersion: service.configuration().version, selection });
  return { repository, scope, service, gateway, providers, version(value: number) { version = value; }, human(value: boolean) { human = value; } };
}
async function completedRun(messages: ChatMessage[]): Promise<ModelEvent[]> {
  if (!messages.some(message => message.role === "tool" && message.images?.length)) return [event("computer.screenshot", {})];
  return [event("computer.task.finish", { status: "completed", summary: "Verified controlled frame", observationId: observation(messages) })];
}
function scripted(action: (messages: ChatMessage[]) => Promise<ModelEvent[]>): ModelProvider["run"] {
  return async function* (messages) { for (const value of await action(messages)) yield value; };
}
describe("computer task ownership and lifecycle (simulated adapter, real SQLite)", () => {
  it("persists model selection independently and rejects conflicting saves without overwriting drafts", () => {
    const f = fixture(scripted(completedRun)), originalBot = f.repository.getBot(f.scope.executorBotId).modelSelection;
    const config = f.service.configuration(), next = { ...selection, modelId: "another-model" };
    f.service.saveConfiguration({ expectedVersion: config.version, selection: next });
    expect(() => f.service.saveConfiguration({ expectedVersion: config.version, selection })).toThrowError(expect.objectContaining({ code: "COMPUTER_TASK_CONFLICT" }));
    expect(f.service.configuration().selection).toEqual(next);
    expect(f.repository.getBot(f.scope.executorBotId).modelSelection).toEqual(originalBot);
  });
  it("requires an authorized finish receipt and retains a nonce conflict", async () => {
    const f = fixture(scripted(completedRun)), input = { ...f.scope, goal: "Inspect controlled screen", clientNonce: randomUUID() };
    const task = await f.service.start(input);
    await expect.poll(() => f.service.get({ ...f.scope, id: task.id }).task.state).toBe("completed");
    expect((await f.service.start(input)).id).toBe(task.id);
    await expect(f.service.start({ ...input, goal: "Changed goal" })).rejects.toMatchObject({ code: "COMPUTER_TASK_CONFLICT" });
    expect(f.service.get({ ...f.scope, id: task.id }).task.modelSelection).toEqual(selection);
  });
  it("persists the selected host window before model setup and reuses that snapshot for a nonce", async () => {
    const f = fixture(scripted(completedRun));
    const first = { kind: "app" as const, pid: 123, startedAt: 1000, windowId: 4, appName: "Test", title: "Pinned" };
    let selected = first; f.gateway.target = () => "mac"; f.gateway.hostTarget = () => selected;
    f.providers.get = async () => { selected = { ...first, windowId: 8 }; return { id: selection.providerInstanceId, version: 1, status: "available" }; };
    const input = { ...f.scope, goal: "Observe pinned window", clientNonce: randomUUID() };
    const task = await f.service.start(input);
    expect(task.hostTarget).toEqual(first);
    await expect.poll(() => f.service.get({ ...f.scope, id: task.id }).task.state).toBe("completed");
    expect((await f.service.start(input)).hostTarget).toEqual(first);
    expect((await f.service.start({ ...input, clientNonce: randomUUID() })).hostTarget?.kind).toBe("app");
    expect(f.repository.computerTasks.get(task).hostTarget).toEqual(first);
  });
  it("does not count model prose as completed work", async () => {
    const f = fixture(async function* () { yield { type: "delta", text: "Everything is done" }; });
    const task = await f.service.start({ ...f.scope, goal: "Create a file", clientNonce: randomUUID() });
    await expect.poll(() => f.service.get({ ...f.scope, id: task.id }).task.state).toBe("paused");
    expect(f.gateway.execute).not.toHaveBeenCalled();
    expect(f.service.get({ ...f.scope, id: task.id }).task.errorCode).toBe("MODEL_NO_ACTION");
  });
  it("starts six isolated computers before the first result and does not serialize members globally", async () => {
    const f = fixture(scripted(completedRun)); let ready = 0, release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.gateway.prepare).mockImplementation(async () => { ready++; await barrier; return frame(); });
    const scopes = [f.scope, ...Array.from({ length: 5 }, () => { const owner = f.repository.createBot(); return { sessionId: owner.session.id, executorBotId: owner.bot.id }; })];
    const tasks = await Promise.all(scopes.map(scope => f.service.start({ ...scope, goal: "Inspect", clientNonce: randomUUID() })));
    await expect.poll(() => ready).toBe(6);
    try { expect(tasks.every(task => f.service.get({ sessionId: task.sessionId, executorBotId: task.executorBotId, id: task.id }).task.state === "running")).toBe(true); } finally { release(); }
    await expect.poll(() => tasks.map(task => f.service.get({ sessionId: task.sessionId, executorBotId: task.executorBotId, id: task.id }).task.state)).toEqual(Array(6).fill("completed"));
  });
  it("pauses at human takeover and refreshes before continuing", async () => {
    let calls = 0;
    const f = fixture(async function* (messages, signal) {
      if (calls++ === 0) { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); signal.throwIfAborted(); }
      yield (await completedRun(messages))[0]!;
    });
    const task = await f.service.start({ ...f.scope, goal: "Inspect", clientNonce: randomUUID() });
    await expect.poll(() => calls).toBe(1);
    f.human(true); await f.service.controlChanged(f.scope, "user");
    expect(f.service.get({ ...f.scope, id: task.id }).task.state).toBe("waiting_user");
    expect(f.gateway.prepare).toHaveBeenCalledOnce();
    f.human(false); await f.service.controlChanged(f.scope, "ai");
    await expect.poll(() => f.service.get({ ...f.scope, id: task.id }).task.state).toBe("completed");
    expect(f.gateway.prepare).toHaveBeenCalledTimes(2);
  });
  it.each(["cancel", "takeover"])("keeps unconfirmed input cleanup failed after %s instead of reporting stopped", async mode => {
    const f = fixture(async function* (messages) { yield event(messages.some(message => message.role === "tool" && message.images?.length) ? "computer.click" : "computer.screenshot", {}); });
    f.gateway.target = () => "mac";
    let inputStarted = false;
    vi.mocked(f.gateway.execute).mockImplementation(async (_task, operation, _input, _step, signal) => {
      if (operation === "computer.screenshot") return frame();
      inputStarted = true; await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      throw new AevorenBotError("HOST_COMPUTER_STOP_UNKNOWN");
    });
    const task = await f.service.start({ ...f.scope, goal: "Test cleanup uncertainty", clientNonce: randomUUID() });
    await expect.poll(() => inputStarted).toBe(true);
    if (mode === "cancel") {
      const current = f.service.get({ ...f.scope, id: task.id }).task;
      expect(await f.service.cancel({ ...f.scope, id: task.id, expectedVersion: current.version })).toMatchObject({ state: "failed", errorCode: "HOST_COMPUTER_STOP_UNKNOWN" });
    } else await expect(f.service.controlChanged(f.scope, "user", "mac")).rejects.toMatchObject({ code: "HOST_COMPUTER_STOP_UNKNOWN" });
    const detail = f.service.get({ ...f.scope, id: task.id });
    expect(detail.task).toMatchObject({ state: "failed", errorCode: "HOST_COMPUTER_STOP_UNKNOWN" });
    expect(detail.steps.find(step => step.operation === "computer.click")).toMatchObject({ state: "unknown", result: { replayAllowed: false } });
  });
  it("stops one task without completing or cancelling a sibling", async () => {
    const f = fixture(async function* (_messages, signal) { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); signal.throwIfAborted(); yield { type: "delta", text: "unreachable after cancellation" }; });
    const second = f.repository.createBot(), siblingScope = { sessionId: second.session.id, executorBotId: second.bot.id };
    const first = await f.service.start({ ...f.scope, goal: "Wait", clientNonce: randomUUID() }), sibling = await f.service.start({ ...siblingScope, goal: "Wait", clientNonce: randomUUID() });
    await expect.poll(() => f.service.get({ ...siblingScope, id: sibling.id }).task.state).toBe("running");
    const current = f.service.get({ ...f.scope, id: first.id }).task;
    await f.service.cancel({ ...f.scope, id: first.id, expectedVersion: current.version });
    expect(f.service.get({ ...f.scope, id: first.id }).task.state).toBe("cancelled");
    expect(f.service.get({ ...siblingScope, id: sibling.id }).task.state).toBe("running");
    expect(() => f.service.get({ ...siblingScope, id: first.id })).toThrowError(expect.objectContaining({ code: "COMPUTER_TASK_NOT_FOUND" }));
  });
  it("keeps interrupted effects unknown and rejects a changed provider when resuming", async () => {
    const f = fixture(scripted(completedRun));
    const created = f.repository.computerTasks.create({ ...f.scope, goal: "Write", clientNonce: randomUUID() }, null, selection, 1).task;
    f.repository.computerTasks.update(created, 1, { state: "running" });
    f.repository.computerTasks.beginStep(created, "computer.click", {});
    f.repository.computerTasks.recover();
    const recovered = f.service.get({ ...f.scope, id: created.id });
    expect(recovered.task.state).toBe("interrupted"); expect(recovered.steps[0]!.state).toBe("unknown");
    expect(f.gateway.execute).not.toHaveBeenCalled();
    f.version(2);
    await expect(f.service.resume({ ...f.scope, id: created.id, expectedVersion: recovered.task.version })).rejects.toMatchObject({ code: "COMPUTER_MODEL_CHANGED" });
    expect(f.gateway.execute).not.toHaveBeenCalled();
  });
  it("cancels a queued task without waiting for another control task and never starts it", async () => {
    const f = fixture(async function* (_messages, signal) {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      signal.throwIfAborted(); yield { type: "delta", text: "unreachable" };
    });
    const first = await f.service.start({ ...f.scope, goal: "First owns the computer", clientNonce: randomUUID() });
    await expect.poll(() => f.service.get({ ...f.scope, id: first.id }).task.state).toBe("running");
    const second = await f.service.start({ ...f.scope, goal: "Queued", clientNonce: randomUUID() });
    await expect(f.service.cancel({ ...f.scope, id: second.id, expectedVersion: second.version })).resolves.toMatchObject({ state: "cancelled" });
    expect(f.service.get({ ...f.scope, id: first.id }).task.state).toBe("running");
    expect(f.gateway.prepare).toHaveBeenCalledOnce();
  });
  it("aborts and awaits a pending visual probe on shutdown without starting desktop work", async () => {
    const f = fixture(scripted(completedRun));
    const probing = new ComputerTaskService(f.repository, f.providers as never, f.gateway, undefined, async (_provider, signal) => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); signal.throwIfAborted();
    });
    services.push(probing);
    const pending = probing.test(f.scope).catch(error => error);
    await expect.poll(() => f.providers.createProvider.mock.calls.length).toBe(1);
    await probing.close();
    expect(await pending).toBeInstanceOf(Error);
    expect(probing.list(f.scope)).toEqual([]); expect(f.gateway.prepare).not.toHaveBeenCalled();
  });
  it("checks actual state before another effect or completion after an unknown click", async () => {
    let round = 0, clicks = 0;
    const f = fixture(scripted(async messages => {
      switch (round++) {
        case 0: return [event("computer.screenshot", {})];
        case 1: case 2: return [event("computer.click", {})];
        case 3: return [event("computer.task.finish", { status: "completed", summary: "Must be rejected", observationId: observation(messages) })];
        case 4: return [event("computer.screenshot", {})];
        case 5: return [event("computer.click", {})];
        default: return [event("computer.task.finish", { status: "completed", summary: "Checked actual state", observationId: observation(messages) })];
      }
    }));
    vi.mocked(f.gateway.execute).mockImplementation(async (_task, operation) => {
      if (operation === "computer.click" && ++clicks === 1) throw new AevorenBotError("TOOL_STATE_INVALID");
      return frame();
    });
    const task = await f.service.start({ ...f.scope, goal: "Check unknown result", clientNonce: randomUUID() });
    await expect.poll(() => f.service.get({ ...f.scope, id: task.id }).task.state).toBe("completed");
    const detail = f.service.get({ ...f.scope, id: task.id });
    expect(clicks).toBe(2); expect(round).toBe(7);
    expect(detail.steps.filter(step => step.operation === "computer.click").map(step => step.state)).toEqual(["unknown", "completed"]);
  });
  it("pauses after exactly 100 actions without using the parent Bot's 16-round budget", async () => {
    const f = fixture(scripted(async messages => [event(messages.some(message => message.role === "tool" && message.images?.length) ? "computer.click" : "computer.screenshot", {})]));
    const task = await f.service.start({ ...f.scope, goal: "Exercise bounded segment", clientNonce: randomUUID() });
    await expect.poll(() => f.service.get({ ...f.scope, id: task.id }).task.state).toBe("paused");
    const detail = f.service.get({ ...f.scope, id: task.id });
    expect(detail.task).toMatchObject({ actionCount: 100, errorCode: "COMPUTER_TASK_BUDGET" });
    expect(detail.steps.filter(step => step.operation === "computer.click")).toHaveLength(100);
  });
  it("requires a new frame when an executed action cannot return screenshot feedback", async () => {
    let round = 0;
    const f = fixture(scripted(async messages => {
      switch (round++) {
        case 0: case 3: return [event("computer.screenshot", {})];
        case 1: return [event("computer.click", {})];
        default: return [event("computer.task.finish", { status: "completed", summary: "Verified after the action", observationId: observation(messages) })];
      }
    }));
    vi.mocked(f.gateway.execute).mockImplementation(async (_task, operation) => operation === "computer.screenshot" ? frame() : {
      result: { action: "performed", feedback: { status: "unavailable", actionAlreadyExecuted: true } },
    });
    const task = await f.service.start({ ...f.scope, goal: "Inspect the actual action result", clientNonce: randomUUID() });
    await expect.poll(() => f.service.get({ ...f.scope, id: task.id }).task.state).toBe("completed");
    expect(round).toBe(5);
    expect(f.gateway.execute).toHaveBeenCalledTimes(3);
    expect(f.service.get({ ...f.scope, id: task.id }).steps.filter(step => step.operation === "computer.click")).toHaveLength(1);
  });
  it("returns a durable task before the visual probe finishes and can cancel that probe", async () => {
    const f = fixture(scripted(completedRun));
    const verifying = new ComputerTaskService(f.repository, f.providers as never, f.gateway, undefined, async (_provider, signal) => {
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); signal.throwIfAborted();
    }); services.push(verifying);
    const task = await verifying.start({ ...f.scope, goal: "Connection is still checking", clientNonce: randomUUID() });
    await expect.poll(() => verifying.get({ ...f.scope, id: task.id }).task.result).toBe("正在验证电脑模型");
    const current = verifying.get({ ...f.scope, id: task.id }).task;
    expect(await verifying.cancel({ ...f.scope, id: current.id, expectedVersion: current.version })).toMatchObject({ state: "cancelled" });
    expect(f.gateway.prepare).not.toHaveBeenCalled();
  });

});

it("pins the computer target, preserves nonce identity, and serializes physical Mac tasks across chats", async () => {
  let running = 0, maximum = 0, released = 0;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(scripted(completedRun));
  f.gateway.target = () => "mac";
  f.gateway.prepare = vi.fn(async () => { running++; maximum = Math.max(maximum, running); await barrier; return frame(); });
  f.gateway.releaseInput = async () => { running--; released++; };
  const second = f.repository.createBot(), scope = { sessionId: second.session.id, executorBotId: second.bot.id };
  const input = { ...f.scope, goal: "Inspect Mac", clientNonce: randomUUID() };
  const first = await f.service.start(input), next = await f.service.start({ ...scope, goal: "Inspect Mac 2", clientNonce: randomUUID() });
  expect(first.target).toBe("mac"); expect(next.target).toBe("mac");
  await expect.poll(() => f.gateway.prepare).toHaveBeenCalledTimes(1);
  f.gateway.target = () => "builtin";
  expect((await f.service.start(input)).id).toBe(first.id);
  await expect(f.service.start({ ...input, target: "builtin" })).rejects.toMatchObject({ code: "COMPUTER_TASK_CONFLICT" });
  release!();
  await expect.poll(() => released).toBe(2);
  expect(maximum).toBe(1);
  expect(f.service.get({ ...scope, id: next.id }).task.target).toBe("mac");
});

it("keeps builtin stop separate from Mac tasks and denies model journal reads during Mac takeover", async () => {
  const f = fixture(scripted(completedRun));
  const created = f.repository.computerTasks.create({ ...f.scope, target: "mac", goal: "Pending Mac work", clientNonce: randomUUID() }, null, selection, 1).task;
  await f.service.cancelScope(f.scope, "builtin");
  expect(f.service.get({ ...f.scope, id: created.id }).task.state).toBe("queued");
  f.human(true);
  expect(() => f.service.assertReadable(f.scope, created.id)).toThrowError(expect.objectContaining({ code: "COMPUTER_USER_CONTROLLED" }));
  expect(() => f.service.assertReadable(f.scope)).toThrowError(expect.objectContaining({ code: "COMPUTER_USER_CONTROLLED" }));
  f.human(false);
  expect(() => f.service.assertReadable(f.scope, created.id)).not.toThrow();
  await f.service.cancelScope(f.scope, "mac");
  expect(f.service.get({ ...f.scope, id: created.id }).task.state).toBe("cancelled");
});

it.each([
  ["queued", "COMPUTER_USER_CONTROLLED"], ["completed", "COMPUTER_USER_CONTROLLED"], ["completed", "HOST_COMPUTER_PERMISSION"],
] as const)("cancels a %s Mac task without exposing results blocked by %s", async (state, code) => {
  const f = fixture(scripted(completedRun));
  const created = f.repository.computerTasks.create({ ...f.scope, target: "mac", goal: "Private Mac goal", clientNonce: randomUUID() }, null, selection, 1).task;
  const task = f.repository.computerTasks.update(created, created.version, { state, result: "Private screen contents" });
  f.gateway.assertAI = () => { throw new AevorenBotError(code); };
  const handlers = new Map<string, (input?: unknown) => unknown>();
  addComputerTaskProductHandlers(handlers, { repository: f.repository, computerTaskService: f.service }, { ...f.scope, runtimeRunId: randomUUID() });
  const result = await handlers.get("computerTasks:cancel")!({ id: task.id, expectedVersion: task.version });
  const current = f.service.get({ ...f.scope, id: task.id }).task;
  expect(result).toEqual({ id: current.id, state: state === "queued" ? "cancelled" : "completed", version: current.version });
  expect(current.result).toBe("Private screen contents");
  expect(f.gateway.cancel).toHaveBeenCalledTimes(state === "queued" ? 1 : 0);
});

function parentRun(f: ReturnType<typeof fixture>, scope = f.scope) {
  const nonce = randomUUID(); f.repository.prepareMessage({ sessionId: scope.sessionId, clientNonce: nonce, text: "Controlled computer parent" });
  const run = f.repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: scope.executorBotId, profileVersion: 1, sessionId: scope.sessionId, generation: 1, inputSeq: 1, blocks: [], digest: "owned-parent" });
  f.repository.transitionRuntimeRun(run.id, "dispatching"); return f.repository.transitionRuntimeRun(run.id, "running", { providerRequestId: randomUUID() });
}

it.each(["valid", "no-parent", "wrong-step", "wrong-path", "old-boot", "write-reference"])("validates file delivery references through the actual task loop: %s", async mode => {
  const content = "Actual fixture bytes", sha256 = createHash("sha256").update(content).digest("hex");
  const path = "result.md"; let round = 0, finishReply: string | undefined;
  const f = fixture(scripted(async messages => {
    switch (round++) {
      case 0: return [event("computer.screenshot", {})];
      case 1: return [event("execution.writeFile", { path, content })];
      case 2: return [event("execution.readFile", { path })];
      case 3: {
        const reply = JSON.parse(messages.findLast(message => message.role === "tool")!.content) as { fileEvidence: Array<{ stepId: string; operation: string }> };
        expect(reply.fileEvidence).toHaveLength(2);
        const file = reply.fileEvidence.find(file => file.operation === (mode === "write-reference" ? "execution.writeFile" : "execution.readFile"))!;
        if (mode === "old-boot") {
          const environment = f.repository.environments.getInternal(f.scope)!;
          f.repository.environments.update(f.scope, environment.version, { bootId: randomUUID() });
        }
        return [event("computer.task.finish", { status: "completed", summary: "Verified file", observationId: observation(messages),
          outputFiles: [{ stepId: mode === "wrong-step" ? randomUUID() : file.stepId, path: mode === "wrong-path" ? "other.md" : path }] })];
      }
      default: finishReply = messages.findLast(message => message.role === "tool")!.content; return [];
    }
  }));
  f.gateway.definitions = [...f.gateway.definitions, ...["execution.writeFile", "execution.readFile"].map(name => ({ name, channel: name, description: "Controlled file fixture", effectClass: name.endsWith("readFile") ? "read-local" as const : "write-reversible" as const, interaction: "none" as const }))];
  f.gateway.schemas = { ...f.gateway.schemas, "execution.readFile": z.object({ path: z.string() }), "execution.writeFile": z.object({ path: z.string(), content: z.string() }) };
  const environment = f.repository.environments.ensure(f.scope, { workerVersion: "1.3.0", imageRef: "fixture", imageDigest: `sha256:${"a".repeat(64)}`, platform: "linux/arm64" });
  const bootId = randomUUID(); f.repository.environments.update(f.scope, environment.version, { bootId });
  vi.mocked(f.gateway.execute).mockImplementation(async (_task, operation) => operation === "execution.readFile"
    ? { result: { path, size: Buffer.byteLength(content), sha256, content, encoding: "utf8" } }
    : operation === "execution.writeFile" ? { ...frame(), result: { action: { path, size: Buffer.byteLength(content), sha256 } } } : frame());
  const parent = mode === "no-parent" ? null : parentRun(f), accepted = mode === "valid" || mode === "no-parent";
  const task = await f.service.start({ ...f.scope, goal: "Save and deliver file", clientNonce: randomUUID() }, parent?.id ?? null);
  await expect.poll(() => f.repository.computerTasks.get(task).state).toBe(accepted ? "completed" : "paused");
  const detail = f.service.get({ ...f.scope, id: task.id }), fileSteps = detail.steps.filter(step => step.operation.startsWith("execution."));
  expect(fileSteps).toHaveLength(2);
  expect(fileSteps.every(step => step.fileEvidence?.parentRunId === (parent?.id ?? null) && step.fileEvidence.bootId === bootId)).toBe(true);
  if (accepted) expect(detail.task.outputFiles).toEqual([{ stepId: fileSteps[1]!.id, path }]);
  else { expect(detail.task.outputFiles ?? []).toEqual([]); expect(JSON.parse(finishReply!)).toMatchObject({ ok: false, code: "TOOL_EVIDENCE_REQUIRED" }); }
});

it("hands off an already completed child only to its own parent, without replay", async () => {
  const f = fixture(scripted(completedRun)), parent = parentRun(f);
  const task = await f.service.start({ ...f.scope, goal: "Inspect fixture", clientNonce: randomUUID() }, parent.id);
  await expect.poll(() => f.repository.computerTasks.get(task).state).toBe("completed");
  const waited = await f.service.waitForParent({ ...f.scope, id: task.id }, parent.id, new AbortController().signal);
  expect(waited.task.state).toBe("completed"); expect(waited.steps.length).toBeGreaterThan(0);
  await expect(f.service.waitForParent({ ...f.scope, id: task.id }, randomUUID(), new AbortController().signal)).rejects.toMatchObject({ code: "BROWSER_SCOPE_INVALID" });
  expect(f.gateway.prepare).toHaveBeenCalledOnce();
});

it("ends a parent's wait on takeover without reading private steps or result", async () => {
  const f = fixture(async function* (_messages, signal) { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); signal.throwIfAborted(); yield { type: "delta", text: "Unreachable after cancellation" }; });
  f.gateway.target = () => "mac";
  const parent = parentRun(f), task = await f.service.start({ ...f.scope, goal: "Wait for user", clientNonce: randomUUID() }, parent.id);
  await expect.poll(() => f.repository.computerTasks.get(task).state).toBe("running");
  const waited = f.service.waitForParent({ ...f.scope, id: task.id }, parent.id, new AbortController().signal);
  f.human(true); const steps = vi.spyOn(f.repository.computerTasks, "steps");
  await f.service.controlChanged(f.scope, "user", "mac");
  const after = steps.mock.calls.length;
  expect(await waited).toMatchObject({ task: { id: task.id, state: "waiting_user", result: null }, steps: [] });
  expect(steps.mock.calls.length).toBe(after);
});

it("cancels only the owned child when its parent wait is aborted", async () => {
  const f = fixture(async function* (_messages, signal) { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); signal.throwIfAborted(); yield { type: "delta", text: "Unreachable after cancellation" }; });
  const parent = parentRun(f), task = await f.service.start({ ...f.scope, goal: "Own child", clientNonce: randomUUID() }, parent.id);
  const other = f.repository.createBot(), siblingScope = { sessionId: other.session.id, executorBotId: other.bot.id };
  const sibling = await f.service.start({ ...siblingScope, goal: "Sibling", clientNonce: randomUUID() });
  await expect.poll(() => f.repository.computerTasks.get(sibling).state).toBe("running");
  const controller = new AbortController(), waited = f.service.waitForParent({ ...f.scope, id: task.id }, parent.id, controller.signal);
  const cancelled = expect(waited).rejects.toMatchObject({ name: "AbortError" }); controller.abort(); await cancelled;
  expect(f.repository.computerTasks.get(task).state).toBe("cancelled"); expect(f.repository.computerTasks.get(sibling).state).toBe("running");
});

it("stops an owned child even when the parent signal was already aborted before subscribing", async () => {
  const f = fixture(async function* (_messages, signal) { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); signal.throwIfAborted(); yield { type: "delta", text: "Unreachable after cancellation" }; });
  const parent = parentRun(f), task = await f.service.start({ ...f.scope, goal: "Cancel at handoff boundary", clientNonce: randomUUID() }, parent.id);
  await expect.poll(() => f.repository.computerTasks.get(task).state).toBe("running");
  const controller = new AbortController(); controller.abort();
  await expect(f.service.waitForParent({ ...f.scope, id: task.id }, parent.id, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(f.repository.computerTasks.get(task).state).toBe("cancelled");
});

it("bounds a queued parent wait, cancels only that task and retains its actual state", async () => {
  const f = fixture(async function* (_messages, signal) { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); signal.throwIfAborted(); yield { type: "delta", text: "Unreachable after cancellation" }; });
  const parent = parentRun(f), active = await f.service.start({ ...f.scope, goal: "Own computer first", clientNonce: randomUUID() }, parent.id);
  await expect.poll(() => f.repository.computerTasks.get(active).state).toBe("running");
  const queued = await f.service.start({ ...f.scope, goal: "Queue behind own task", clientNonce: randomUUID() }, parent.id);
  vi.useFakeTimers();
  try {
    const waited = f.service.waitForParent({ ...f.scope, id: queued.id }, parent.id, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(await waited).toMatchObject({ task: { id: queued.id, state: "cancelled" }, waitExpired: true });
    expect(f.repository.computerTasks.get(active).state).toBe("running"); expect(f.gateway.prepare).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});

it("rebinds an explicitly resumed task to its current scoped parent", async () => {
  const f = fixture(scripted(completedRun)), old = parentRun(f);
  const created = f.repository.computerTasks.create({ ...f.scope, goal: "Continue checkpoint", clientNonce: randomUUID() }, old.id, selection, 1).task;
  const paused = f.repository.computerTasks.update(created, created.version, { state: "paused" });
  f.repository.transitionRuntimeRun(old.id, "completed"); const parent = parentRun(f);
  const task = await f.service.resume({ ...f.scope, id: paused.id, expectedVersion: paused.version }, parent.id);
  expect(task.parentRunId).toBe(parent.id); expect(f.repository.computerTasks.forParent(old.id)).toEqual([]);
  const detail = await f.service.waitForParent({ ...f.scope, id: task.id }, parent.id, new AbortController().signal);
  expect(detail.task.state).toBe("completed"); expect(f.repository.computerTasks.forParent(parent.id)[0]?.state).toBe("completed");
});

it("does not enqueue a resumed child after the new parent has already cancelled", async () => {
  const f = fixture(scripted(completedRun)), parent = parentRun(f);
  const created = f.repository.computerTasks.create({ ...f.scope, goal: "Cancelled resume", clientNonce: randomUUID() }, null, selection, 1).task;
  const paused = f.repository.computerTasks.update(created, created.version, { state: "paused" });
  const controller = new AbortController(); controller.abort();
  await expect(f.service.resume({ ...f.scope, id: paused.id, expectedVersion: paused.version }, parent.id, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(f.repository.computerTasks.get(paused)).toMatchObject({ state: "paused", parentRunId: null }); expect(f.gateway.prepare).not.toHaveBeenCalled();
});

it("cleans up a pending parent wait on shutdown without restarting interrupted work", async () => {
  const f = fixture(async function* (_messages, signal) { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); signal.throwIfAborted(); yield { type: "delta", text: "Unreachable after cancellation" }; });
  const parent = parentRun(f), task = await f.service.start({ ...f.scope, goal: "Close safely", clientNonce: randomUUID() }, parent.id);
  await expect.poll(() => f.repository.computerTasks.get(task).state).toBe("running");
  const waited = f.service.waitForParent({ ...f.scope, id: task.id }, parent.id, new AbortController().signal);
  const rejected = expect(waited).rejects.toMatchObject({ name: "AbortError" }); await f.service.close(); await rejected;
  expect(f.repository.computerTasks.get(task).state).toBe("interrupted"); expect(f.gateway.prepare).toHaveBeenCalledOnce();
});
