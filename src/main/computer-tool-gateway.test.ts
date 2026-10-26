import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRepository } from "./database";
import type { BrowserService } from "./browser-service";
import type { EnvironmentService } from "./environment-service";
import { createComputerToolGateway } from "./computer-tool-gateway";
import { environmentFileWriteSchema, executionRunSchema, registerPortSchema } from "@shared/environment-schemas";

const repositories: AppRepository[] = [];
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });

function fixture() {
  const repository = new AppRepository(":memory:");
  repositories.push(repository);
  const actor = repository.createBot();
  const scope = { sessionId: actor.session.id, executorBotId: actor.bot.id };
  const task = repository.computerTasks.create({ ...scope, goal: "Inspect an owned local service", clientNonce: randomUUID(), target: "builtin" }, null,
    { providerInstanceId: "codex.default", modelId: "fixture-model" }, 1).task;
  const preview = { id: randomUUID(), state: "open" };
  const browser = {
    previewList: vi.fn(async () => [preview]), previewOpen: vi.fn(async () => preview), previewClose: vi.fn(async () => preview),
    view: vi.fn(async () => ({ owner: "ai", epoch: 1 })),
    computerScreenshot: vi.fn(async () => { throw new Error("No fixture frame"); }),
  };
  const environment = {
    registerPort: vi.fn(async (input: unknown) => { const parsed = registerPortSchema.parse(input); return { id: randomUUID(), processId: parsed.processId, port: parsed.port, state: "listening" }; }),
    writeFile: vi.fn(async (input: unknown) => { const parsed = environmentFileWriteSchema.parse(input); return { path: parsed.path, sha256: "a".repeat(64), size: parsed.content.length }; }),
    run: vi.fn(async (input: unknown) => { executionRunSchema.parse(input); return { id: randomUUID(), state: "completed" }; }),
  };
  const gateway = createComputerToolGateway(repository, browser as unknown as BrowserService, environment as unknown as EnvironmentService);
  return { scope, task, preview, browser, environment, gateway };
}

describe("isolated computer registered previews", () => {
  it("discovers the existing scoped preview operations", () => {
    const f = fixture();
    expect(f.gateway.definitions.map(definition => definition.name)).toEqual(expect.arrayContaining(["preview.list", "preview.open", "preview.close"]));
  });

  it("lists previews through the browser service with the task's bound scope", async () => {
    const f = fixture(), signal = new AbortController().signal;
    expect((await f.gateway.execute(f.task, "preview.list", { expectedEpoch: 1 }, randomUUID(), signal)).result).toEqual([f.preview]);
    expect(f.browser.previewList).toHaveBeenCalledWith({ ...f.scope, expectedEpoch: 1 }, expect.objectContaining({ actor: "ai", signal }));
  });

  it("opens only a registered port with a host-owned action identity", async () => {
    const f = fixture(), stepId = randomUUID(), registeredPortId = randomUUID(), signal = new AbortController().signal;
    expect((await f.gateway.execute(f.task, "preview.open", { expectedEpoch: 1, registeredPortId }, stepId, signal)).result).toMatchObject({ action: f.preview });
    expect(f.browser.previewOpen).toHaveBeenCalledWith({ ...f.scope, expectedEpoch: 1, registeredPortId, clientNonce: stepId }, expect.objectContaining({ actor: "ai", signal, operationId: stepId }));
  });

  it("does not inject an unsupported nonce into registered-port input", async () => {
    const f = fixture(), processId = randomUUID(), signal = new AbortController().signal;
    const result = await f.gateway.execute(f.task, "processes.registerPort", { processId, port: 8766 }, randomUUID(), signal);
    expect(result.result).toMatchObject({ action: { processId, port: 8766, state: "listening" } });
    expect(f.environment.registerPort).toHaveBeenCalledWith({ ...f.scope, processId, port: 8766 }, signal);
  });

  it("keeps writeFile input within its strict schema", async () => {
    const f = fixture(), signal = new AbortController().signal;
    await f.gateway.execute(f.task, "execution.writeFile", { path: "visual/cover.png", content: "fixture" }, randomUUID(), signal);
    expect(f.environment.writeFile).toHaveBeenCalledWith({ ...f.scope, path: "visual/cover.png", content: "fixture" }, signal);
  });

  it("still injects the host action identity where execution.run requires it", async () => {
    const f = fixture(), stepId = randomUUID();
    await f.gateway.execute(f.task, "execution.run", { command: "pwd" }, stepId, new AbortController().signal);
    expect(f.environment.run).toHaveBeenCalledWith(expect.objectContaining({ ...f.scope, command: "pwd", cwd: ".", clientNonce: stepId }), null, false, expect.any(AbortSignal));
  });

  it("rejects a foreign scope before the browser service is called", async () => {
    const f = fixture();
    await expect(f.gateway.execute(f.task, "preview.open", { sessionId: randomUUID(), expectedEpoch: 1, registeredPortId: randomUUID() }, randomUUID(), new AbortController().signal))
      .rejects.toMatchObject({ code: "BROWSER_SCOPE_INVALID" });
    expect(f.browser.previewOpen).not.toHaveBeenCalled();
  });
});

it("cancels only owned effects even if their successful dispatch receipt was lost", async () => {
  const repository = new AppRepository(":memory:");
  try {
    const owner = repository.createBot(), scope = { sessionId: owner.session.id, executorBotId: owner.bot.id };
    repository.environments.ensure(scope, { workerVersion: "1.2.0", imageRef: "controlled", imageDigest: `sha256:${"a".repeat(64)}`, platform: "linux/arm64" });
    const task = repository.computerTasks.create({ ...scope, clientNonce: randomUUID(), goal: "Cancel only this task" }, null, repository.getDefaultModelSelection(), 1).task;
    const installStep = repository.computerTasks.beginStep(task, "applications.install", {});
    const install = repository.applications.create({ ...scope, clientNonce: installStep.id, name: "Owned install", source: { kind: "apt", packages: ["xterm"], executable: "xterm" } }, "linux/arm64").application;
    repository.computerTasks.finishStep(task, installStep, "unknown", { code: "TOOL_EXECUTION_CANCELLED" });
    const commandStep = repository.computerTasks.beginStep(task, "execution.run", {}), backgroundStep = repository.computerTasks.beginStep(task, "processes.start", {});
    const session = repository.environments.createSession(scope, null);
    const foreground = repository.environments.createExecution(scope, { executionSessionId: session.id, clientNonce: commandStep.id, kind: "foreground", command: "sleep 20" }).execution;
    repository.environments.createExecution(scope, { executionSessionId: session.id, clientNonce: backgroundStep.id, kind: "background", command: "sleep 30" });
    const cancel = vi.fn(async () => foreground), cancelBuild = vi.fn(), stopScope = vi.fn(async () => {});
    const gateway = createComputerToolGateway(repository, {} as never, { getExecution: async () => foreground, cancel } as never, { stopScope, cancelBuild } as never);
    await gateway.cancel(task);
    expect(cancelBuild).toHaveBeenCalledExactlyOnceWith(scope, install.id);
    expect(cancel).toHaveBeenCalledExactlyOnceWith({ ...scope, id: foreground.id });
    expect(stopScope).toHaveBeenCalledExactlyOnceWith(scope, true, task.id);
  } finally { repository.close(); }
});
