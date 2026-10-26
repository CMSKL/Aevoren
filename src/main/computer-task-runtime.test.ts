import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { ProductToolRequest } from "@shared/contracts";
import type { ComputerTask, ComputerTaskStart } from "@shared/computer-task-contracts";
import type { ChatMessage, ModelProvider } from "./model";
import type { ProductDependencies } from "./product-handlers";
import { AppRepository } from "./database";
import { ProductOperationService } from "./product-operation-service";
import { GeneralSettingsService } from "./settings";
import { SendWorker } from "./send-worker";
import { RoomCoordinator } from "./room-coordinator";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";

vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));
function deferred() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }

it.each(["api", "native"])("waits for its computer after the queued Journal receipt, without polling (%s)", async transport => {
  const repository = new AppRepository(":memory:"), owner = repository.createBot(), gate = deferred();
  const scope = { sessionId: owner.session.id, executorBotId: owner.bot.id };
  let task: ComputerTask | undefined, streamClosed = false, nativeResponse: string | undefined, calls = 0;
  const received: ChatMessage[][] = [];
  const provider: ModelProvider = { testConnection: async () => {}, async *run(messages) {
    calls++; received.push(messages.map(message => ({ ...message })));
    yield { type: "started", requestId: randomUUID() };
    if (calls === 1) {
      try {
        yield { type: "project-tool", toolCallId: "owned-computer", tool: { kind: "product-call", action: "execute", operation: "computer.tasks.start", input: { goal: "Inspect the controlled fixture" } },
          ...(transport === "native" ? { toolSignal: new AbortController().signal, respond: async (content: string) => { nativeResponse = content; } } : {}) };
        if (transport === "api") { yield { type: "completed", finishReason: "tool_calls" }; return; }
      } finally { streamClosed = true; }
    }
    yield { type: "delta", text: "状态已核验。" };
    yield { type: "completed", finishReason: "stop" };
  } };
  const workspaceService = new WorkspaceService(repository), executor = new WorkspaceToolExecutor(repository, workspaceService);
  const coordinator = new WorkspaceToolCoordinator(repository, executor, () => {});
  const events = { transcript: () => {}, runtime: () => {}, sendState: () => {}, roomRuntime: () => {} };
  const worker = new SendWorker(repository, null, events, false, provider, undefined, coordinator);
  const waitForParent = vi.fn(async (input: { id: string }, parent: string) => {
    expect(task?.parentRunId).toBe(parent); expect(task?.id).toBe(input.id);
    expect(repository.listToolInvocations(scope.sessionId).find(value => value.toolCallId === "owned-computer")?.state).toBe("succeeded");
    if (transport === "api") expect(streamClosed).toBe(true);
    await gate.promise;
    const environment = repository.environments.ensure(scope, { workerVersion: "1.3.0", imageRef: "fixture", imageDigest: `sha256:${"a".repeat(64)}`, platform: "linux/arm64" });
    const bootId = randomUUID(); repository.environments.update(scope, environment.version, { bootId });
    const content = "Actual child file", path = "child.md", sha256 = createHash("sha256").update(content).digest("hex");
    const step = repository.computerTasks.beginStep(task!, "execution.readFile", { path });
    repository.computerTasks.finishStep(task!, { ...step, fileEvidence: { parentRunId: parent, environmentId: environment.id, bootId, imageDigest: environment.imageDigest } }, "completed",
      { path, content, encoding: "utf8", size: Buffer.byteLength(content), sha256 });
    task = repository.computerTasks.update(task!, repository.computerTasks.get(task!).version, { state: "completed", result: "Actual child result", outputFiles: [{ stepId: step.id, path }] });
    return { task, steps: repository.computerTasks.steps(task) };
  });
  const computerTaskService = { start: async (input: ComputerTaskStart, parent: string) => {
    task = repository.computerTasks.create(input, parent, repository.getDefaultModelSelection(), 1).task; return task;
  }, waitForParent };
  executor.setProductOperations(new ProductOperationService({ repository, workspaceService, workspaceToolCoordinator: coordinator, sendWorker: worker,
    roomCoordinator: new RoomCoordinator(repository, worker.executor, events), generalSettings: new GeneralSettingsService(repository),
    providers: { list: async () => [], isSupported: () => true }, computerTaskService, updateService: {} } as unknown as ProductDependencies));
  try {
    const sent = worker.send({ sessionId: scope.sessionId, clientNonce: randomUUID(), text: "执行本轮受控任务。" });
    await expect.poll(() => task !== undefined).toBe(true);
    expect(waitForParent).toHaveBeenCalledOnce();
    expect(calls).toBe(1); expect(nativeResponse).toBeUndefined();
    const initial = repository.listToolInvocations(scope.sessionId)[0]!;
    expect(JSON.parse(repository.findProductOperationResult(sent.clientNonce, initial.arguments as ProductToolRequest, scope.executorBotId)!).result.state).toBe("queued");
    gate.resolve();
    await expect.poll(() => repository.getRuntimeRun(sent.runId).state).toBe("completed");
    const content = transport === "native" ? nativeResponse : received[1]?.findLast(message => message.role === "tool")?.content;
    expect(JSON.parse(content!).result.task).toMatchObject({ id: task!.id, state: "completed", result: "Actual child result" });
    expect(JSON.parse(content!).fileEvidence).toMatchObject([{ taskId: task!.id, operation: "execution.readFile", path: "child.md", delivered: true }]);
    expect(calls).toBe(transport === "native" ? 1 : 2);
    expect(repository.listToolInvocations(scope.sessionId)).toHaveLength(1);
    expect(JSON.parse(repository.findProductOperationResult(sent.clientNonce, initial.arguments as ProductToolRequest, scope.executorBotId)!).result.state).toBe("queued");
  } finally { gate.resolve(); await worker.shutdown(); repository.close(); }
});
