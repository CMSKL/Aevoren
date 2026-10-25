import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ModelProvider } from "./model";
import { AppRepository } from "./database";
import { SendWorker } from "./send-worker";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { NetworkToolExecutor } from "./network-tool-executor";
import { DecisionService, FakeDecisionProvider } from "./decision-service";

const repositories: AppRepository[] = [];
const directories: string[] = [];

function directory(): string {
  const value = mkdtempSync(join(tmpdir(), "aevoren-tool-runtime-"));
  directories.push(value);
  return value;
}

afterEach(() => {
  vi.unstubAllGlobals();
  while (repositories.length > 0) repositories.pop()?.close();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("structured host tool Runtime wiring", () => {
  it("continues one in-process CLI dynamic tool turn after the approved host response", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const created = repository.createBot();
    let hostResult = "";
    const provider: ModelProvider = {
      async *run() {
        yield { type: "started", requestId: "cli-dynamic" };
        yield {
          type: "network-tool",
          toolCallId: "cli-time",
          tool: { kind: "time-now", timezone: "Asia/Shanghai" },
          respond: async (content: string) => { hostResult = content; },
        };
        yield { type: "delta", text: `CLI_RESULT:${hostResult}` };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const service = new WorkspaceService(repository);
    const decisions = new DecisionService(repository, new FakeDecisionProvider(() => ({
      answers: {
        riskLevel: { value: 0, confidence: 0.98 },
        needsHumanApproval: { value: true, confidence: 0.99 },
      },
      modelVersion: "fake-decision-1",
      requestId: "tool-shadow",
    })), true);
    const coordinator = new WorkspaceToolCoordinator(
      repository,
      new WorkspaceToolExecutor(repository, service, new NetworkToolExecutor(() => new Date("2026-09-17T08:00:00.000Z"))),
      (event) => {
        if (event.approval.state === "pending") {
          queueMicrotask(() => void coordinator.resolve(event.sessionId, event.approval.id, event.approval.version, "allow-once"));
        }
      },
      decisions,
    );
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "CLI 查询时间" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));
    expect(hostResult).toContain("2026-09-17T08:00:00.000Z");
    expect(repository.listTranscript(created.session.id).at(-1)?.body).toContain("CLI_RESULT");
    expect(repository.listToolInvocations(created.session.id)[0]).toMatchObject({ state: "succeeded", toolKind: "time-now" });
    await vi.waitFor(() => expect(repository.listDecisionJournals()).toHaveLength(2));
    expect(repository.listDecisionJournals().map((entry) => entry.policyId)).toEqual(expect.arrayContaining([
      "tool-risk-shadow",
      "tool-result-quality-shadow",
    ]));
    expect(repository.listDecisionJournals().every((entry) => entry.state === "completed")).toBe(true);
    const riskJournal = repository.listDecisionJournals().find((entry) => entry.policyId === "tool-risk-shadow")!;
    const qualityJournal = repository.listDecisionJournals().find((entry) => entry.policyId === "tool-result-quality-shadow")!;
    expect(riskJournal.answers.existingApproval?.value).toMatchObject({ state: "pending" });
    expect(qualityJournal.answers.existingResult?.value).toMatchObject({ resultCharacters: expect.any(Number) });
  });

  it("keeps fetched page text out of the journal while returning it to the same approved model run", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const created = repository.createBot();
    const calls: ChatMessage[][] = [];
    const provider: ModelProvider = {
      async *run(messages) {
        calls.push(messages.map((message) => ({ ...message })));
        const toolResult = messages.findLast((message) => message.role === "tool");
        yield { type: "started", requestId: `fetch-${calls.length}` };
        if (!toolResult) {
          yield { type: "network-tool", toolCallId: "fetch-1", tool: { kind: "web-fetch", url: "https://example.com/brief", maxCharacters: 5_000 } };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "delta", text: `FETCH_USED:${toolResult.content}` };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const service = new WorkspaceService(repository);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html><head><title>Brief</title></head><body>PRIVATE_FETCHED_PAGE</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })));
    const network = new NetworkToolExecutor(
      () => new Date("2026-09-17T08:00:00.000Z"),
      async (value) => ({ url: new URL(value), addresses: [{ address: "93.184.216.34", family: 4 }] }),
      async (target, signal) => {
        const response = await fetch(target.url, { signal });
        return {
          status: response.status,
          headers: {
            "content-type": response.headers.get("content-type") ?? undefined,
            "content-length": response.headers.get("content-length") ?? undefined,
          },
          body: response.body!,
        };
      },
    );
    const coordinator = new WorkspaceToolCoordinator(
      repository,
      new WorkspaceToolExecutor(repository, service, network),
      (event) => {
        if (event.approval.state === "pending") {
          queueMicrotask(() => void coordinator.resolve(event.sessionId, event.approval.id, event.approval.version, "allow-once"));
        }
      },
    );
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "读取来源页面" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));

    expect(calls).toHaveLength(2);
    expect(calls[1]?.find((message) => message.role === "tool")?.content).toContain("PRIVATE_FETCHED_PAGE");
    const invocation = repository.listToolInvocations(created.session.id)[0]!;
    expect(invocation).toMatchObject({
      toolKind: "web-fetch",
      effectClass: "read-remote",
      targetPath: "https://example.com/brief",
      state: "succeeded",
      resultMetadata: { provider: "example.com", retrievedAt: "2026-09-17T08:00:00.000Z", title: "Brief" },
    });
    expect(JSON.stringify(invocation)).not.toContain("PRIVATE_FETCHED_PAGE");
  });

  it("executes an approved read-only network query, returns sourced data, and stores only a result digest", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const created = repository.createBot();
    const calls: ChatMessage[][] = [];
    const provider: ModelProvider = {
      async *run(messages, _signal, _context) {
        calls.push(messages.map((message) => ({ ...message })));
        const toolResult = messages.findLast((message) => message.role === "tool");
        yield { type: "started", requestId: `network-${calls.length}` };
        if (!toolResult) {
          yield { type: "network-tool", toolCallId: "time-1", tool: { kind: "time-now", timezone: "Asia/Shanghai" }, providerToolName: "time_now" };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "delta", text: `TIME_RESULT:${toolResult.content}` };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const service = new WorkspaceService(repository);
    const coordinator = new WorkspaceToolCoordinator(
      repository,
      new WorkspaceToolExecutor(repository, service, new NetworkToolExecutor(() => new Date("2026-09-17T08:00:00.000Z"))),
      (event) => {
        if (event.approval.state === "pending") {
          queueMicrotask(() => void coordinator.resolve(event.sessionId, event.approval.id, event.approval.version, "allow-once"));
        }
      },
    );
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "现在几点" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));

    expect(calls).toHaveLength(2);
    expect(calls[1]?.find((message) => message.role === "assistant" && "tool_calls" in message)).toMatchObject({
      tool_calls: [{ function: { name: "time_now" } }],
    });
    expect(calls[1]?.find((message) => message.role === "tool")?.content).toContain("2026-09-17T08:00:00.000Z");
    const invocation = repository.listToolInvocations(created.session.id)[0]!;
    expect(invocation).toMatchObject({
      toolKind: "time-now",
      effectClass: "pure",
      workspaceId: null,
      targetPath: "Asia/Shanghai",
      state: "succeeded",
      resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(invocation)).not.toContain("localDateTime");
    expect(JSON.stringify(invocation)).not.toContain("\"untrusted\":false");
  });

  it("fails a completed-looking reply that claims a file read without a succeeded tool record", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const created = repository.createBot();
    const provider: ModelProvider = {
      async *run() {
        yield { type: "started", requestId: "false-read-claim" };
        yield { type: "delta", text: "已真实调用 workspace_read 并成功读取 CSV 文件。" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "读取 CSV" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("failed"));
    expect(repository.getRuntimeRun(sent.runId).lastErrorCode).toBe("TOOL_EVIDENCE_REQUIRED");
    expect(repository.listToolInvocations(created.session.id)).toEqual([]);
    expect(repository.listTranscript(created.session.id).at(-1)).toMatchObject({ status: "failed" });
  });

  it("fails a completed-looking reply that claims an audit artifact was written without a succeeded tool record", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const created = repository.createBot();
    const provider: ModelProvider = {
      async *run() {
        yield { type: "started", requestId: "false-write-claim" };
        yield { type: "delta", text: "审校稿已由真实工具写入。" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "写入审校稿文件" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("failed"));
    expect(repository.getRuntimeRun(sent.runId).lastErrorCode).toBe("TOOL_EVIDENCE_REQUIRED");
    expect(repository.listToolInvocations(created.session.id)).toEqual([]);
  });

  it("requires real search and fetch evidence for an explicit research task but preserves local-only planning", async () => {
    for (const request of ["你帮我去调研一下个人网站如何做呢", "请调研个人网站如何做", "只规划一下调研方案，不联网"]) {
      const repository = new AppRepository(":memory:");
      repositories.push(repository);
      const created = repository.createBot();
      const provider: ModelProvider = {
        async *run() {
          yield { type: "started", requestId: "text-only-research" };
          yield { type: "delta", text: "以下是基于训练知识的一般建议，未执行实际检索。" };
          yield { type: "completed", finishReason: "stop" };
        },
        testConnection: async () => {},
      };
      const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider);
      const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: request });
      const planning = request.includes("不联网");
      await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe(planning ? "completed" : "failed"));
      if (!planning) expect(repository.getRuntimeRun(sent.runId).lastErrorCode).toBe("TASK_REQUIREMENTS_UNMET");
      expect(repository.listToolInvocations(created.session.id)).toEqual([]);
    }
  });

  it("does not require negated tools, while positive requirements in mixed instructions still need real evidence", async () => {
    for (const [request, required] of [
      ["请本轮负责人只用一行确认已收到，不调用任何工具、不读取文件、不委派任务、不执行外部动作。", false],
      ["请所有成员各用一行确认收到这条消息；不调用工具、不读取文件、不委派、不执行任何外部动作。", false],
      ["请确认收到，不要读取文件，也不要写入。", false],
      ["Please acknowledge; do not read files or use tools.", false],
      ["请真实调研个人网站，不联网。", false],
      ["请实际读取文件，但不要写入。", true],
      ["Do not write files; read the file.", true],
      ["不要读取文件，请实际写入文件。", true],
      ["不要写入文件但是请实际读取文件。", true],
      ["Don't write files but read the file.", true],
      ["不要写入任何文件但先读取文件。", true],
      ["不使用搜索结果并请实际读取文件。", true],
      ["Do not write files and please read the file.", true],
    ] as const) {
      const repository = new AppRepository(":memory:");
      repositories.push(repository);
      const created = repository.createBot();
      const provider: ModelProvider = {
        async *run() {
          yield { type: "started", requestId: "negated-requirements-regression" };
          yield { type: "delta", text: "已收到，本轮不调用工具、不读取文件、不抓取网页、不写入文件、不创建 Bot、不组建群聊。" };
          yield { type: "completed", finishReason: "stop" };
        },
        testConnection: async () => {},
      };
      const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider);
      const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: request });
      await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe(required ? "failed" : "completed"));
      if (required) expect(repository.getRuntimeRun(sent.runId).lastErrorCode).toBe("TASK_REQUIREMENTS_UNMET");
      expect(repository.listToolInvocations(created.session.id)).toEqual([]);
    }
  });

  it("does not let a negated neighboring action waive a positive unverified read, fetch or write claim", async () => {
    for (const body of ["本轮不写入文件但已读取文件。", "本轮不读取文件但已抓取网页。", "本轮不读取文件但已写入文件。", "本轮不读取文件但已创建 Bot。", "本轮不读取文件但已组建群聊。"]) {
      const repository = new AppRepository(":memory:");
      repositories.push(repository);
      const created = repository.createBot();
      const provider: ModelProvider = {
        async *run() {
          yield { type: "started", requestId: "mixed-claim-regression" };
          yield { type: "delta", text: body };
          yield { type: "completed", finishReason: "stop" };
        },
        testConnection: async () => {},
      };
      const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider);
      const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "确认收到；不要调用工具。" });
      await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("failed"));
      expect(repository.getRuntimeRun(sent.runId).lastErrorCode).toBe("TOOL_EVIDENCE_REQUIRED");
      expect(repository.listToolInvocations(created.session.id)).toEqual([]);
    }
  });

  it("rejects CSV metrics and length claims without their exact deterministic evidence tools", async () => {
    for (const fixture of [
      { request: "分析 metrics.csv 的浏览和互动指标", body: "总浏览 7700，总互动 85，最高互动率 4%。", code: "DATA_EVIDENCE_REQUIRED" },
      { request: "计算这段内容的非空白字符数", body: "该内容共有 205 个非空白字符。", code: "MEASUREMENT_EVIDENCE_REQUIRED" },
    ]) {
      const repository = new AppRepository(":memory:");
      repositories.push(repository);
      const created = repository.createBot();
      const provider: ModelProvider = {
        async *run() {
          yield { type: "started", requestId: fixture.code };
          yield { type: "delta", text: fixture.body };
          yield { type: "completed", finishReason: "stop" };
        },
        testConnection: async () => {},
      };
      const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider);
      const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: fixture.request });
      await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("failed"));
      expect(repository.getRuntimeRun(sent.runId).lastErrorCode).toBe(fixture.code);
    }
  });

  it("auto-approves exact text measurement and accepts the resulting length claim", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const created = repository.createBot();
    let round = 0;
    const provider: ModelProvider = {
      async *run(messages) {
        round += 1;
        yield { type: "started", requestId: `measure-${round}` };
        if (!messages.some((message) => message.role === "tool")) {
          yield { type: "computation-tool", toolCallId: "measure-1", tool: { kind: "text-measure", text: "你好 A" }, providerToolName: "text_measure" };
          yield { type: "completed", finishReason: "tool_calls" };
          return;
        }
        yield { type: "delta", text: "确定性结果为 3 个非空白字符。" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const service = new WorkspaceService(repository);
    const coordinator = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, service), vi.fn());
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "计算非空白字符数" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));
    expect(repository.listToolInvocations(created.session.id)).toMatchObject([
      { toolKind: "text-measure", effectClass: "pure", state: "succeeded" },
    ]);
    expect(repository.listTranscript(created.session.id).at(-1)).toMatchObject({ status: "completed" });
  });

  it("cancels a pending approval with its Runtime and never resumes it", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const root = directory();
    writeFileSync(join(root, "brief.txt"), "NEVER_READ", "utf8");
    const service = new WorkspaceService(repository);
    repository.setSetting("tools.autoApprovePublicRead", "false", false);
    const { project } = await service.registerRoot(root);
    const created = repository.createBot(project.id);
    const pending = vi.fn();
    const provider: ModelProvider = {
      async *run() {
        yield { type: "started", requestId: "cancel-tool" };
        yield { type: "network-tool", toolCallId: "cancel-read", tool: { kind: "time-now", timezone: "UTC" } };
        yield { type: "completed", finishReason: "tool_calls" };
      },
      testConnection: async () => {},
    };
    const coordinator = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, service, new NetworkToolExecutor()), pending);
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "取消" });
    await vi.waitFor(() => expect(repository.listPendingApprovalRequests(created.session.id)).toHaveLength(1));
    worker.cancelRun(sent.runId);
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("cancelled"));
    expect(repository.listToolInvocations(created.session.id)[0]).toMatchObject({ state: "cancelled", attemptCount: 0, workspaceId: null });
    expect(repository.listPendingApprovalRequests(created.session.id)).toEqual([]);
  });

  it("stops a model that exceeds sixteen consecutive supported host tool rounds", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const root = directory();
    const service = new WorkspaceService(repository);
    const registered = await service.registerRoot(root);
    const created = repository.createBot(registered.project.id);
    let calls = 0;
    const provider: ModelProvider = {
      async *run() {
        calls += 1;
        yield { type: "started", requestId: `loop-${calls}` };
        yield { type: "network-tool", toolCallId: `loop-tool-${calls}`, tool: { kind: "time-now", timezone: "UTC" } };
        yield { type: "completed", finishReason: "tool_calls" };
      },
      testConnection: async () => {},
    };
    const coordinator = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, service, new NetworkToolExecutor()), (event) => {
      if (event.approval.state === "pending") {
        queueMicrotask(() => void coordinator.resolve(event.sessionId, event.approval.id, event.approval.version, "allow-once"));
      }
    });
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "循环保护" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("failed"));
    expect(repository.getRuntimeRun(sent.runId).lastErrorCode).toBe("TOOL_ROUND_LIMIT_EXCEEDED");
    expect(repository.listToolInvocations(created.session.id)).toHaveLength(16);
    expect(repository.listToolInvocations(created.session.id).every((invocation) => invocation.state === "succeeded")).toBe(true);
    expect(calls).toBe(17);
  });

  it("allows up to thirty-two bounded rounds for an explicit deterministic length-convergence task", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const service = new WorkspaceService(repository);
    const created = repository.createBot();
    let calls = 0;
    const provider: ModelProvider = {
      async *run() {
        calls += 1;
        yield { type: "started", requestId: `measure-loop-${calls}` };
        yield { type: "computation-tool", toolCallId: `measure-${calls}`, tool: { kind: "text-measure", text: "仍需继续收敛" }, providerToolName: "text_measure" };
        yield { type: "completed", finishReason: "tool_calls" };
      },
      testConnection: async () => {},
    };
    const coordinator = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, service), vi.fn());
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "用 text_measure 精确计算字符数并持续修订长度" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("failed"));
    expect(repository.getRuntimeRun(sent.runId).lastErrorCode).toBe("TOOL_ROUND_LIMIT_EXCEEDED");
    expect(repository.listToolInvocations(created.session.id)).toHaveLength(32);
    expect(calls).toBe(33);
  });

  it("bounds draft-stage measurement retries and returns control to the writer without weakening final measurement evidence", async () => {
    const repository = new AppRepository(":memory:");
    repositories.push(repository);
    const service = new WorkspaceService(repository);
    const created = repository.createBot();
    repository.updateBot(created.bot.id, created.bot.version, { name: "内容主笔" });
    let calls = 0;
    const provider: ModelProvider = {
      async *run(messages) {
        calls += 1;
        yield { type: "started", requestId: `draft-measure-${calls}` };
        const lastTool = messages.findLast((message) => message.role === "tool");
        if (lastTool?.content.includes("TEXT_MEASURE_DRAFT_LIMIT_REACHED")) {
          yield { type: "delta", text: "初稿阶段已停止循环测量，交由事实编辑完成最终收敛。" };
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        yield { type: "computation-tool", toolCallId: `draft-measure-tool-${calls}`, tool: { kind: "text-measure", text: "仍在修订的真实初稿" }, providerToolName: "text_measure" };
        yield { type: "completed", finishReason: "tool_calls" };
      },
      testConnection: async () => {},
    };
    const coordinator = new WorkspaceToolCoordinator(repository, new WorkspaceToolExecutor(repository, service), vi.fn());
    const worker = new SendWorker(repository, null, { transcript: vi.fn(), sendState: vi.fn(), runtime: vi.fn() }, false, provider, undefined, coordinator);
    const sent = worker.send({ sessionId: created.session.id, clientNonce: crypto.randomUUID(), text: "用 text_measure 精确记录初稿长度" });
    await vi.waitFor(() => expect(repository.getRuntimeRun(sent.runId).state).toBe("completed"));
    expect(repository.listToolInvocations(created.session.id)).toHaveLength(6);
    expect(calls).toBe(8);
    expect(repository.listTranscript(created.session.id).at(-1)?.body).toContain("事实编辑");
  });
});
