import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerTaskState, ComputerTaskStep } from "@shared/computer-task-contracts";
import type { ModelProvider } from "./model";
import { AppRepository } from "./database";
import { SendWorker } from "./send-worker";
import { computerFileEvidence } from "./computer-file-evidence";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const content = "verified output", digest = createHash("sha256").update(content).digest("hex");
type Record = { operation: string; path?: string; state?: ComputerTaskStep["state"]; sha256?: string; bytes?: number; content?: string; noIdentity?: boolean; wrongBoot?: boolean; wrongImage?: boolean; wrongParent?: boolean; deliver?: boolean; direct?: boolean; task?: number };
async function run(records: Record[], options: { request?: string; body?: string; taskState?: ComputerTaskState; foreign?: boolean; oldSegment?: boolean; userControlled?: boolean } = {}) {
  const repository = new AppRepository(":memory:"); cleanup.push(() => repository.close());
  const owner = repository.createBot(), scope = { sessionId: owner.session.id, executorBotId: owner.bot.id };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const provider: ModelProvider = { testConnection: async () => {}, async *run() {
    yield { type: "started", requestId: randomUUID() }; await gate;
    yield { type: "delta", text: options.body ?? "已写入文件并回读。" }; yield { type: "completed", finishReason: "stop" };
  } };
  const worker = new SendWorker(repository, null, { transcript: vi.fn(), runtime: vi.fn(), sendState: vi.fn() }, false, provider);
  cleanup.push(() => worker.shutdown());
  const sent = worker.send({ ...scope, clientNonce: randomUUID(), text: options.request ?? "请保存 result.md，保存后回读。" });
  await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("running"));
  const environment = repository.environments.ensure(scope, { workerVersion: "1.3.0", imageRef: "fixture", imageDigest: `sha256:${"a".repeat(64)}`, platform: "linux/arm64" });
  const bootId = randomUUID(); repository.environments.update(scope, environment.version, { bootId });
  const tasks = Array.from({ length: Math.max(0, ...records.map(record => record.task ?? 0)) + 1 }, () => repository.computerTasks.create({ ...scope, clientNonce: randomUUID(), goal: "Create the requested output" }, options.foreign ? null : sent.runId, repository.getDefaultModelSelection(), 1).task);
  const outputs = new Map(tasks.map(task => [task.id, [] as Array<{ stepId: string; path: string }>]));
  for (const record of records) {
    const task = tasks[record.task ?? 0]!, path = record.path ?? "result.md", writing = record.operation === "execution.writeFile";
    if (record.direct) {
      const prepared = repository.prepareToolInvocation({ runtimeRunId: sent.runId, toolCallId: randomUUID(), idempotencyKey: randomUUID(),
        tool: { kind: "product-call", action: "execute", operation: record.operation, input: { path, ...(writing ? { content: record.content ?? content } : {}) } } });
      repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
      repository.transitionToolInvocation(prepared.invocation.id, "dispatching"); repository.transitionToolInvocation(prepared.invocation.id, "running");
      repository.completeProductToolInvocation(prepared.invocation.id, digest, JSON.stringify({ ok: true }), {
        status: "completed", operation: record.operation, measurementResource: path, measurementDigest: record.sha256 ?? digest, measurementBytes: content.length, truncated: false,
        fileEnvironmentId: environment.id, fileBootId: record.wrongBoot ? randomUUID() : bootId,
        fileImageDigest: record.wrongImage ? `sha256:${"b".repeat(64)}` : environment.imageDigest, fileEvidenceOrdinal: repository.nextFileEvidenceOrdinal(),
      });
      continue;
    }
    const step = repository.computerTasks.beginStep(task, record.operation, { path, ...(writing ? { content: record.content ?? content } : {}) });
    const file = { path, size: record.bytes ?? content.length, sha256: record.sha256 ?? digest, ...(!writing ? { content: record.content ?? content, encoding: "utf8" } : {}) };
    repository.computerTasks.finishStep(task, { ...step, ...(!record.noIdentity ? { fileEvidence: { parentRunId: record.wrongParent ? randomUUID() : sent.runId, environmentId: environment.id,
      bootId: record.wrongBoot ? randomUUID() : bootId, imageDigest: record.wrongImage ? `sha256:${"b".repeat(64)}` : environment.imageDigest } } : {}) }, record.state ?? "completed", writing ? { action: file, feedback: { status: "unavailable" } } : file);
    if (record.deliver) outputs.get(task.id)!.push({ stepId: step.id, path });
  }
  for (const task of tasks) repository.computerTasks.update(task, task.version, { state: options.taskState ?? "completed", outputFiles: outputs.get(task.id), ...(options.oldSegment ? { segment: 2 } : {}) });
  if (options.userControlled) {
    repository.browsers.ensure(scope, { environmentId: environment.id });
    const browser = repository.browsers.view(scope)!; repository.browsers.claimControl(scope, { owner: "user", expectedEpoch: browser.epoch });
  }
  const files = computerFileEvidence(repository, sent.runId);
  release(); await vi.waitFor(() => expect(["completed", "failed"]).toContain(repository.getRuntimeRun(sent.runId).state));
  return { state: repository.getRuntimeRun(sent.runId).state, error: repository.getRuntimeRun(sent.runId).lastErrorCode, files };
}
const write = { operation: "execution.writeFile" }, read = { operation: "execution.readFile" };
describe("host-owned computer file results reach the parent", () => {
  it("accepts a real write and full readback with task and environment identities", async () => {
    const result = await run([write, read]);
    expect(result).toMatchObject({ state: "completed", error: null });
    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toMatchObject({ operation: write.operation, path: "result.md", sha256: digest, bytes: content.length, delivered: false });
  });
  it("accepts a command-created deliverable only through its verified read reference", async () => {
    expect(await run([{ ...read, deliver: true }])).toMatchObject({ state: "completed", error: null });
    expect(await run([read])).toMatchObject({ state: "failed", error: "TASK_REQUIREMENTS_UNMET" });
  });
  it.each([{ records: [{ ...write, direct: true }, read] }, { records: [write, { ...read, direct: true }] }])("combines parent and child operations with matching identity: $records", async ({ records }) => {
    expect(await run(records)).toMatchObject({ state: "completed", error: null });
  });
  it.each([{ records: [{ ...write, direct: true, wrongBoot: true }, read] }, { records: [write, { ...read, direct: true, wrongImage: true }] }])("does not combine a stale parent receipt: $records", async ({ records }) => {
    expect(await run(records)).toMatchObject({ state: "failed", error: "TASK_REQUIREMENTS_UNMET" });
  });
  it("uses operation order across tasks instead of task creation order", async () => {
    const newerContent = "new output", newerDigest = createHash("sha256").update(newerContent).digest("hex");
    expect(await run([{ ...write, task: 1 }, { ...read, task: 1 }, { ...write, task: 0, content: newerContent, sha256: newerDigest, bytes: newerContent.length }], { taskState: "failed" }))
      .toMatchObject({ state: "failed", error: "TASK_REQUIREMENTS_UNMET" });
    expect(await run([{ ...write, task: 1 }, { ...write, task: 0, content: newerContent, sha256: newerDigest, bytes: newerContent.length },
      { ...read, task: 0, content: newerContent, sha256: newerDigest, bytes: newerContent.length }], { taskState: "failed" }))
      .toMatchObject({ state: "completed", error: null });
  });
  it("does not use an earlier read or delivered reference after a later write", async () => {
    expect(await run([read, write])).toMatchObject({ state: "failed", error: "TASK_REQUIREMENTS_UNMET" });
    const result = await run([{ ...read, deliver: true }, write]);
    expect(result).toMatchObject({ state: "failed", error: "TASK_REQUIREMENTS_UNMET" });
    expect(result.files.find(file => file.operation === "execution.readFile")?.delivered).toBe(false);
    expect(await run([{ ...read, deliver: true }, { ...write, direct: true }])).toMatchObject({ state: "failed", error: "TASK_REQUIREMENTS_UNMET" });
  });
  it("preserves completed file actions even when the child later fails", async () => {
    expect(await run([write, read], { taskState: "failed" })).toMatchObject({ state: "completed", error: null });
  });
  it.each([
    { name: "completed summary alone", records: [] },
    { name: "command result alone", records: [{ operation: "execution.run" }] },
    { name: "failed write", records: [{ ...write, state: "failed" as const }, read] },
    { name: "unknown write", records: [{ ...write, state: "unknown" as const }, read] },
    { name: "missing host identity", records: [{ ...write, noIdentity: true }, read] },
    { name: "previous worker boot", records: [{ ...write, wrongBoot: true }, read] },
    { name: "other image", records: [{ ...write, wrongImage: true }, read] },
    { name: "other parent identity", records: [{ ...write, wrongParent: true }, read] },
    { name: "wrong output path", records: [{ ...write, path: "other.md" }, read] },
    { name: "wrong digest", records: [{ ...write, sha256: "f".repeat(64) }, read] },
    { name: "wrong byte count", records: [{ ...write, bytes: 99 }, read] },
    { name: "different readback bytes", records: [write, { ...read, content: "different" }] },
  ])("rejects $name", async ({ records }) => {
    expect(await run(records)).toMatchObject({ state: "failed", error: "TASK_REQUIREMENTS_UNMET" });
  });
  it.each([{ foreign: true }, { oldSegment: true }])("rejects a task outside the current parent or segment: %j", async options => {
    expect(await run([write, read], options)).toMatchObject({ state: "failed", error: "TASK_REQUIREMENTS_UNMET", files: [] });
  });
  it("does not expose child file evidence while the user controls the computer", async () => {
    expect(await run([write, read], { userControlled: true })).toMatchObject({ state: "failed", error: "TASK_REQUIREMENTS_UNMET", files: [] });
  });
  it("uses real child reads for required sources without treating them as new output", async () => {
    expect(await run([read], { request: "请读取 result.md。", body: "已读取文件。" })).toMatchObject({ state: "completed", error: null });
  });
  it.each([content.length, 99])("binds byte claims to the actual file: %i", async bytes => {
    expect(await run([read], { request: "处理资料。", body: `result.md 已读取文件，${bytes} bytes。` })).toMatchObject(bytes === content.length ? { state: "completed", error: null } : { state: "failed", error: "TOOL_EVIDENCE_REQUIRED" });
  });
});
