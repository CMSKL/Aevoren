import { describe, expect, it, vi, afterEach } from "vitest";
import { AppRepository } from "./database";
import type { ModelProvider } from "./model";
import { SendWorker } from "./send-worker";

vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

type Evidence = {
  operation: "execution.readFile" | "execution.writeFile" | "execution.run";
  path?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

async function runWithEvidence(body: string, evidence: Evidence[], request = "请处理本轮资料。"): Promise<{ state: string; error: string | null }> {
  const repository = new AppRepository(":memory:");
  cleanup.push(() => repository.close());
  const created = repository.createBot();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const provider: ModelProvider = {
    async *run() {
      yield { type: "started", requestId: "environment-file-evidence" };
      await gate;
      yield { type: "delta", text: body };
      yield { type: "completed", finishReason: "stop" };
    },
    testConnection: async () => {},
  };
  const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider);
  cleanup.push(() => worker.shutdown());
  const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: request });
  await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("running"));
  const scope = { sessionId: created.session.id, executorBotId: created.bot.id };
  const environment = repository.environments.ensure(scope, { workerVersion: "1.3.0", imageRef: "fixture", imageDigest: `sha256:${"a".repeat(64)}`, platform: "linux/arm64" });
  const bootId = crypto.randomUUID(); repository.environments.update(scope, environment.version, { bootId });
  for (const [index, record] of evidence.entries()) {
    const path = record.path ?? "result.md";
    const prepared = repository.prepareToolInvocation({
      runtimeRunId: sent.runId, toolCallId: `environment-file-${index}`, idempotencyKey: crypto.randomUUID(),
      tool: { kind: "product-call", action: "execute", operation: record.operation,
        input: record.operation === "execution.run" ? { command: "true" } : { path, ...(record.operation === "execution.writeFile" ? { content: "evidence" } : {}) } },
    });
    repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
    repository.transitionToolInvocation(prepared.invocation.id, "dispatching");
    repository.transitionToolInvocation(prepared.invocation.id, "running");
    repository.completeProductToolInvocation(prepared.invocation.id, "a".repeat(64), JSON.stringify({ ok: true, path }), {
      status: "completed", operation: record.operation, measurementResource: path, measurementDigest: "b".repeat(64), measurementBytes: 8, truncated: false,
      fileEnvironmentId: environment.id, fileBootId: bootId, fileImageDigest: environment.imageDigest,
      fileEvidenceOrdinal: repository.nextFileEvidenceOrdinal(), ...record.metadata,
    });
  }
  release();
  await vi.waitFor(() => expect(["completed", "failed"]).toContain(repository.getRuntimeRun(sent.runId).state));
  const run = repository.getRuntimeRun(sent.runId);
  return { state: run.state, error: run.lastErrorCode ?? null };
}

describe("file evidence after the workspace removal", () => {
  it.each(["read", "write"] as const)("accepts an actual isolated file %s operation", async action => {
    const operation = action === "read" ? "execution.readFile" : "execution.writeFile";
    const body = action === "read" ? "已读取文件。" : "已写入文件。";
    expect(await runWithEvidence(body, [{ operation }])).toEqual({ state: "completed", error: null });
  });

  it.each(["已读取文件。", "已写入文件。"])("does not treat a command launch as file evidence: %s", async body => {
    expect(await runWithEvidence(body, [{ operation: "execution.run" }])).toEqual({ state: "failed", error: "TOOL_EVIDENCE_REQUIRED" });
  });

  it.each(["已读取文件。", "已写入文件。"])("rejects an unsupported file claim: %s", async body => {
    expect(await runWithEvidence(body, [])).toEqual({ state: "failed", error: "TOOL_EVIDENCE_REQUIRED" });
  });

  it("accepts the requested isolated output and matching full readback", async () => {
    expect(await runWithEvidence("已写入文件并回读。", [{ operation: "execution.writeFile" }, { operation: "execution.readFile" }], "请保存 result.md，保存后回读。"))
      .toEqual({ state: "completed", error: null });
  });

  it.each([
    { name: "different output path", records: [{ operation: "execution.writeFile" as const, path: "other.md" }], request: "请保存 result.md。" },
    { name: "different readback digest", records: [{ operation: "execution.writeFile" as const }, { operation: "execution.readFile" as const, metadata: { measurementDigest: "c".repeat(64) } }], request: "请保存 result.md，保存后回读。" },
    { name: "truncated readback", records: [{ operation: "execution.writeFile" as const }, { operation: "execution.readFile" as const, metadata: { truncated: true } }], request: "请保存 result.md，保存后回读。" },
    { name: "unverified output digest", records: [{ operation: "execution.writeFile" as const, metadata: { measurementDigest: null } }], request: "请保存 result.md。" },
  ])("rejects $name", async ({ records, request }) => {
    expect(await runWithEvidence("已写入文件。", records, request)).toEqual({ state: "failed", error: "TASK_REQUIREMENTS_UNMET" });
  });

  it("requires the final direct write to be read, even within the same millisecond", async () => {
    const write = { operation: "execution.writeFile" as const }, read = { operation: "execution.readFile" as const };
    const newer = { ...write, metadata: { measurementDigest: "c".repeat(64) } };
    expect(await runWithEvidence("已写入文件并回读。", [write, read, newer], "请保存 result.md，保存后回读。"))
      .toEqual({ state: "failed", error: "TASK_REQUIREMENTS_UNMET" });
    expect(await runWithEvidence("已写入文件并回读。", [write, newer, { ...read, metadata: newer.metadata }], "请保存 result.md，保存后回读。"))
      .toEqual({ state: "completed", error: null });
  });

  it.each(["fileEnvironmentId", "fileBootId", "fileImageDigest", "fileEvidenceOrdinal"])('rejects direct output with an invalid %s', async field => {
    expect(await runWithEvidence("已写入文件。", [{ operation: "execution.writeFile", metadata: { [field]: null } }], "请保存 result.md。"))
      .toEqual({ state: "failed", error: "TASK_REQUIREMENTS_UNMET" });
  });

  it("accepts a required source only after its full isolated read", async () => {
    expect(await runWithEvidence("已读取文件。", [{ operation: "execution.readFile" }], "请读取 result.md。"))
      .toEqual({ state: "completed", error: null });
  });

  it("does not accept a partial source read", async () => {
    expect(await runWithEvidence("已读取文件。", [{ operation: "execution.readFile", metadata: { truncated: true } }], "请读取 result.md。"))
      .toEqual({ state: "failed", error: "TOOL_EVIDENCE_REQUIRED" });
  });
});
