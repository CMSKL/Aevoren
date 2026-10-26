import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelProvider } from "./model";
import type { ComputerToolGateway } from "./computer-tool-gateway";
import { AppRepository } from "./database";
import { ComputerTaskService } from "./computer-task-service";
import { computerTaskFileEvidence } from "./computer-file-evidence";

const repositories: AppRepository[] = [], services: ComputerTaskService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const repository of repositories.splice(0)) repository.close(); });

const selection = { providerInstanceId: "openai-compatible.default", modelId: "controlled-computer-model" };
const path = "result.md", content = "Actual fixture bytes", digest = createHash("sha256").update(content).digest("hex");

function fixture() {
  const repository = new AppRepository(":memory:"); repositories.push(repository);
  const owner = repository.createBot(), scope = { sessionId: owner.session.id, executorBotId: owner.bot.id };
  const provider: ModelProvider = { async *run() {}, testConnection: async () => {} };
  const providers = { isSupported: () => true, createProvider: () => provider, getCapabilities: () => ({ toolImageInput: true }),
    get: async () => ({ id: selection.providerInstanceId, version: 1, status: "available" }) };
  const gateway: ComputerToolGateway = { definitions: [], schemas: {}, assertAI: () => {},
    prepare: async () => ({ result: { media: { id: randomUUID(), observationId: randomUUID(), name: "controlled.png", mimeType: "image/png", size: 1, sha256: "a".repeat(64) } } }),
    execute: async () => ({ result: {} }), cancel: async () => {} };
  const service = new ComputerTaskService(repository, providers as never, gateway, undefined, async () => {}); services.push(service);
  const environment = repository.environments.ensure(scope, { workerVersion: "1.3.0", imageRef: "fixture", imageDigest: `sha256:${"a".repeat(64)}`, platform: "linux/arm64" });
  const bootId = randomUUID(); repository.environments.update(scope, environment.version, { bootId });
  return { repository, scope, service, environment, bootId };
}

function readStep(f: ReturnType<typeof fixture>, task: { id: string; sessionId: string; executorBotId: string }, parentRunId: string | null) {
  const step = f.repository.computerTasks.beginStep(task, "execution.readFile", { path });
  f.repository.computerTasks.finishStep(task, { ...step, fileEvidence: { parentRunId, environmentId: f.environment.id, bootId: f.bootId, imageDigest: f.environment.imageDigest } },
    "completed", { path, size: Buffer.byteLength(content), sha256: digest, content, encoding: "utf8" });
  return step;
}

describe("task-level file delivery references", () => {
  it("delivers a current read reference for a UI task without a parent run", () => {
    const f = fixture(), task = f.repository.computerTasks.create({ ...f.scope, goal: "Deliver a file", clientNonce: randomUUID() }, null, selection, 1).task;
    const step = readStep(f, task, null);
    f.repository.computerTasks.update(task, task.version, { state: "completed", outputFiles: [{ stepId: step.id, path }] });
    expect(computerTaskFileEvidence(f.repository, task)).toMatchObject([{ operation: "execution.readFile", path, sha256: digest, delivered: true }]);
  });

  it("rejects a read reference owned by another parent run", () => {
    const f = fixture(), task = f.repository.computerTasks.create({ ...f.scope, goal: "Deliver a file", clientNonce: randomUUID() }, null, selection, 1).task;
    const step = readStep(f, task, randomUUID());
    f.repository.computerTasks.update(task, task.version, { state: "completed", outputFiles: [{ stepId: step.id, path }] });
    expect(computerTaskFileEvidence(f.repository, task)).toEqual([]);
  });

  it("clears stale delivery references and the previous segment when a task resumes", async () => {
    const f = fixture(), task = f.repository.computerTasks.create({ ...f.scope, goal: "Deliver a file", clientNonce: randomUUID() }, null, selection, 1).task;
    const step = readStep(f, task, null);
    const paused = f.repository.computerTasks.update(task, task.version, { state: "paused", outputFiles: [{ stepId: step.id, path }] });
    expect(computerTaskFileEvidence(f.repository, paused)).toMatchObject([{ delivered: true }]);
    const resumed = await f.service.resume({ ...f.scope, id: paused.id, expectedVersion: paused.version });
    expect(resumed.outputFiles).toEqual([]);
    expect(resumed.segment).toBe(paused.segment + 1);
    expect(computerTaskFileEvidence(f.repository, resumed)).toEqual([]);
  });
});
