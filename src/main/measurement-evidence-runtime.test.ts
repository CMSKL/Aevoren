import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it.each(["workspace-read", "workspace-write"] as const)("rejects retired %s before reading or writing, even with old grants", async kind => {
    const root = mkdtempSync(join(tmpdir(), "aevoren-retired-directory-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, "data.csv"), "name\nx\n", "utf8");
    const repository = new AppRepository(":memory:");
    cleanup.push(() => repository.close());
    const service = new WorkspaceService(repository);
    const registered = await service.registerRoot(root);
    repository.updateWorkspacePermissions(registered.workspace.id, registered.workspace.version, { writeEnabled: true, automationEnabled: true });
    const created = repository.createBot(registered.project.id);
    const provider: ModelProvider = {
      async *run(_messages, _signal, context) {
        expect(context?.workspaces).toEqual([]);
        yield { type: "started", requestId: "retired-directory" };
        yield { type: "workspace-tool", toolCallId: "retired-file", tool: kind === "workspace-write"
          ? { kind, workspaceId: registered.workspace.id, path: "output.csv", content: "must not be written" }
          : { kind, workspaceId: registered.workspace.id, path: "data.csv", maxBytes: 4096 } };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const coordinator = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, service), vi.fn());
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    try {
      const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "处理这些资料。" });
      await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("failed"));
      expect(repository.getRuntimeRun(sent.runId).lastErrorCode).toBe("LOCAL_DIRECTORY_ACCESS_REMOVED");
      expect(repository.listToolInvocations(created.session.id)).toEqual([]);
      expect(repository.listPendingApprovalRequests(created.session.id)).toEqual([]);
      expect(readFileSync(join(root, "data.csv"), "utf8")).toBe("name\nx\n");
      expect(existsSync(join(root, "output.csv"))).toBe(false);
      expect(repository.getWorkspace(registered.workspace.id).removedAt).toBeNull();
    } finally { await worker.shutdown(); }
  });

});
