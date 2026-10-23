import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { AppRepository } from "./database";
import { createComputerToolGateway } from "./computer-tool-gateway";

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
