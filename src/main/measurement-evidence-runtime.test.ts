import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRepository } from "./database";
import type { ModelProvider } from "./model";
import { SendWorker } from "./send-worker";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(close => close()); });

describe("measurement evidence in completed Runtime replies", () => {
  it.each([
    { body: "这段文本的 UTF-8 大小是 6 字节。", code: null },
    { body: "这段文本的 UTF-8 大小是 7 字节。", code: "TOOL_EVIDENCE_REQUIRED" },
    { body: "data.csv 是 6 字节。", code: "TOOL_EVIDENCE_REQUIRED" },
  ])("retains deterministic text byte measurement: $body", async ({ body, code }) => {
    const repository = new AppRepository(":memory:");
    cleanup.push(() => repository.close());
    const created = repository.createBot();
    let calls = 0;
    const provider: ModelProvider = {
      async *run() {
        yield { type: "started", requestId: `utf8-${++calls}` };
        if (calls === 1) {
          yield { type: "computation-tool", toolCallId: "measure", tool: { kind: "text-measure", text: "你好" } };
          yield { type: "completed", finishReason: "tool_calls" };
        } else {
          yield { type: "delta", text: body };
          yield { type: "completed", finishReason: "stop" };
        }
      },
      testConnection: async () => {},
    };
    const coordinator = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, new WorkspaceService(repository)), vi.fn());
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "请计算这段文本的 UTF-8 大小" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe(code ? "failed" : "completed"));
    expect(repository.getRuntimeRun(sent.runId).lastErrorCode).toBe(code);
    expect(repository.listToolInvocations(created.session.id)).toMatchObject([{ state: "succeeded", resultMetadata: { utf8Bytes: 6 } }]);
  });

  it.each<{ body: string; code: string | null; write?: boolean; content?: string }>([
    { body: "data.csv 的读取结果是 8 字节。", code: null },
    { body: "data.csv 的读取结果是 8 bytes。", code: null },
    { body: "data.csv 有 1 行数据。", code: null },
    { body: "data.csv 有 9 字节。", code: "TOOL_EVIDENCE_REQUIRED" },
    { body: "other.csv 有 8 字节。", code: "TOOL_EVIDENCE_REQUIRED" },
    { body: "data.csv 有 2 行数据。", code: "TOOL_EVIDENCE_REQUIRED" },
    { body: "data.csv 的写入回执是 8 bytes。", code: null, write: true },
    { body: "data.csv 的写入回执是 9 bytes。", code: "TOOL_EVIDENCE_REQUIRED", write: true },
    { body: "other.csv 的写入回执是 8 bytes。", code: "TOOL_EVIDENCE_REQUIRED", write: true },
    { body: "data.csv 是 8 个非空白字符。", code: "MEASUREMENT_EVIDENCE_REQUIRED", write: true },
    { body: "data.csv 有 1 行数据。", code: "TOOL_EVIDENCE_REQUIRED", write: true },
    { body: "| workspace_write data.csv | ok | 1,008 bytes |", code: null, write: true, content: "x".repeat(1008) },
    { body: "data.csv 的写入回执是 1,009 bytes。", code: "TOOL_EVIDENCE_REQUIRED", write: true, content: "x".repeat(1008) },
    { body: "正文有 8 个非空白字符。", code: "MEASUREMENT_EVIDENCE_REQUIRED" },
    { body: "正文有 8 字。", code: "MEASUREMENT_EVIDENCE_REQUIRED" },
  ])("validates the source and metric of $body", async ({ body, code, write, content = "name\nx\n\n" }) => {
    const root = mkdtempSync(join(tmpdir(), "aevoren-measurement-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    if (!write) writeFileSync(join(root, "data.csv"), content);
    const repository = new AppRepository(":memory:");
    cleanup.push(() => repository.close());
    const service = new WorkspaceService(repository);
    const registered = await service.registerRoot(root);
    if (write) repository.updateWorkspacePermissions(registered.workspace.id, registered.workspace.version, { writeEnabled: true, automationEnabled: false });
    const created = repository.createBot(registered.project.id);
    let calls = 0;
    const provider: ModelProvider = {
      async *run() {
        yield { type: "started", requestId: `metadata-${++calls}` };
        if (calls === 1) {
          yield { type: "workspace-tool", toolCallId: "file", tool: write
            ? { kind: "workspace-write", workspaceId: registered.workspace.id, path: "data.csv", content }
            : { kind: "workspace-read", workspaceId: registered.workspace.id, path: "data.csv", maxBytes: 4096 } };
          yield { type: "completed", finishReason: "tool_calls" };
        } else {
          yield { type: "delta", text: body };
          yield { type: "completed", finishReason: "stop" };
        }
      },
      testConnection: async () => {},
    };
    const coordinator = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, service), event => {
      if (event.approval.state === "pending") queueMicrotask(() => void coordinator.resolve(event.sessionId, event.approval.id, event.approval.version, "allow-once"));
    });
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: write ? "请保存 data.csv，说明写入回执；不要生成新文章。" : "请读取 data.csv，说明读取回执；不要生成新文章。" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe(code ? "failed" : "completed"));
    expect(repository.getRuntimeRun(sent.runId).lastErrorCode).toBe(code);
    expect(repository.listToolInvocations(created.session.id)).toMatchObject([{ state: "succeeded", resultMetadata: { bytes: Buffer.byteLength(content), ...(write ? { created: true } : { csvRowCount: 1 }) } }]);
    expect(repository.listToolInvocations(created.session.id).some(tool => tool.toolKind === "text-measure")).toBe(false);
  });
});
