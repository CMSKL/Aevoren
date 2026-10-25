import type { ToolInvocation } from "@shared/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArtifactStatusBar, RunFailureCard } from "./CollaborationFeedback";

describe("ArtifactStatusBar", () => {
  it("does not render a per-reply Markdown export control when there is no saved artifact", () => {
    const html = renderToStaticMarkup(
      <ArtifactStatusBar writes={[]} />,
    );

    expect(html).toBe("");
    expect(html).not.toContain("保存为 Markdown");
  });
});

describe("MCP host task failure", () => {
  it("keeps the original operation record visible without suggesting model retry", () => {
    const html = renderToStaticMarkup(<RunFailureCard step="MCP 成员" errorCode="TOOL_EXECUTION_CANCELLED" invocations={[]} hostMcp canRetry={false} onRetry={() => undefined} />);
    expect(html).toContain("固定 MCP 参数审批或派发阶段");
    expect(html).toContain("固定参数与原 MCP 操作记录");
    expect(html).toContain("不会自动重新调用");
    expect(html).not.toContain("模型文字阶段");
    expect(html).not.toContain("重试此步骤");
  });
});


const invocation = (patch: Partial<ToolInvocation> = {}): ToolInvocation => ({
  id: "tool-a", runtimeRunId: "run-a", sessionId: "session-a", executorBotId: "bot-a", toolCallId: "call-a",
  idempotencyKey: "nonce-a", commandDigest: "digest-a", toolKind: "product-call", effectClass: "irreversible", workspaceId: null,
  targetPath: "computer.click", arguments: { kind: "product-call", action: "execute", operation: "computer.click", input: {} },
  state: "failed", attemptCount: 1, approvalRequestId: "approval-a", resultDigest: null, resultMetadata: null,
  lastErrorCode: "MODEL_CONNECTION_TIMEOUT", version: 1, createdAt: "2026-10-21T00:00:00.000Z", updatedAt: "2026-10-21T00:00:00.000Z",
  startedAt: "2026-10-21T00:00:00.000Z", finishedAt: "2026-10-21T00:00:01.000Z", ...patch,
});
function failure(code: string, tools: ToolInvocation[] = [], canRetry = true): string {
  return renderToStaticMarkup(<RunFailureCard step="测试" errorCode={code} invocations={tools} canRetry={canRetry} onRetry={() => undefined} />);
}

describe("failure recovery guidance", () => {
  it("names the missing measurement evidence without claiming the model failed to reply", () => {
    const html = failure("MEASUREMENT_EVIDENCE_REQUIRED");
    expect(html).toContain("没有执行确定性计数工具");
    expect(html).toContain("补齐计数证据");
    expect(html).not.toContain("模型回复未完整完成");
    expect(html).not.toContain("不会重复覆盖");
    expect(html).toContain("重试此步骤");
  });
  it("explains an unmet requirement without inventing a missing action or losing verified results", () => {
    const html = failure("TASK_REQUIREMENTS_UNMET", [invocation({ toolKind: "workspace-read", effectClass: "read-local", state: "succeeded" })]);
    expect(html).toContain("必要的工具执行或成果验证未通过");
    expect(html).toContain("1 次真实工具执行");
    expect(html).toContain("已成功的工具结果");
    expect(html).not.toContain("必须创建");
  });
  it.each(["COMPUTER_MEMORY_INSUFFICIENT", "COMPUTER_MEMORY_UNAVAILABLE", "COMPUTER_DESKTOP_UNAVAILABLE", "ENVIRONMENT_UNAVAILABLE", "BROWSER_UNAVAILABLE"])("requires actual computer recovery before %s is retried", code => {
    const html = failure(code);
    expect(html).toContain("先在电脑面板");
    expect(html).not.toContain("重试此步骤</button>");
    expect(html).not.toContain("不会重复覆盖");
  });
  it("does not promise that restarting an exhausted tool budget will succeed", () => {
    const html = failure("TOOL_ROUND_LIMIT_EXCEEDED");
    expect(html).toContain("工具调用次数已达到本次运行上限");
    expect(html).toContain("缩小剩余任务");
    expect(html).not.toContain("重试此步骤</button>");
  });
  it.each(["interrupted-unknown", "dispatching", "running", "failed", "cancelled"] as const)("does not retry an irreversible %s result even if the caller enables retry", state => {
    const html = failure("MODEL_CONNECTION_TIMEOUT", [invocation({ state })]);
    expect(html).toContain("先只读核对实际状态");
    expect(html).not.toContain("重试此步骤</button>");
  });
  it.each(["write-external", "computer-control", "write-reversible"] as const)("also protects unknown %s effects", effectClass => {
    expect(failure("NETWORK_TOOL_TIMEOUT", [invocation({ effectClass, state: "interrupted-unknown" })])).not.toContain("重试此步骤</button>");
  });
  it.each(["denied", "expired", "failed-before-execution"] as const)("does not mistake an unexecuted %s for an unknown result", state => {
    expect(failure("NETWORK_TOOL_TIMEOUT", [invocation({ state, startedAt: null, attemptCount: 0 })])).toContain("重试此步骤</button>");
  });
  it.each(["NETWORK_TOOL_TIMEOUT", "MODEL_CONNECTION_FAILED", "MODEL_RUN_TIMEOUT", "MEASUREMENT_EVIDENCE_REQUIRED"])("retains recovery for safe readonly %s", code => {
    const tools = [invocation({ effectClass: "read-remote", state: "failed" })];
    expect(failure(code, tools)).toContain("重试此步骤</button>");
    expect(failure(code, tools, false)).not.toContain("重试此步骤</button>");
  });
  it("counts only distinct successfully saved paths and makes no overwrite promise", () => {
    const written = invocation({ toolKind: "workspace-write", effectClass: "write-reversible", state: "succeeded", targetPath: "result.md", workspaceId: "workspace-a" });
    const html = failure("MEASUREMENT_EVIDENCE_REQUIRED", [written, { ...written, id: "later-write" }, invocation({ toolKind: "workspace-write", effectClass: "write-reversible", targetPath: "failed.md" })]);
    expect(html).toContain("2 次真实工具执行");
    expect(html).toContain("1 个已保存文件");
    expect(html).not.toContain("不会重复覆盖");
  });
  it("does not invent a reason or retry eligibility for unknown codes", () => {
    const html = failure("UNMAPPED_SECRET_TEXT");
    expect(html).toContain("UNMAPPED_SECRET_TEXT");
    expect(html).toContain("查看技术详情");
    expect(html).not.toContain("重试此步骤</button>");
  });
  it.each(["mcp", "outbound"])("does not offer a model retry for a %s host task with an incorrect caller flag", host => {
    const html = renderToStaticMarkup(<RunFailureCard step="测试" errorCode="NETWORK_TOOL_TIMEOUT" invocations={[]} canRetry onRetry={() => undefined} hostMcp={host === "mcp"} hostOutbound={host === "outbound"} />);
    expect(html).toContain("只读核对");
    expect(html).not.toContain("重试此步骤</button>");
  });
});
