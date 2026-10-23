import type { RuntimeRun, ToolInvocation } from "@shared/contracts";
import { RUN_FAILURE_ERRORS } from "@shared/run-failure-errors";

export function failureRecovery(code: string | null | undefined): { summary: string; next: string; retryable: boolean } {
  const known = code && Object.hasOwn(RUN_FAILURE_ERRORS, code) ? RUN_FAILURE_ERRORS[code as keyof typeof RUN_FAILURE_ERRORS] : null;
  let next = "查看技术详情并核对已有工具记录，再决定下一步。";
  let retryable = known?.retryable ?? false;
  if (code === "MEASUREMENT_EVIDENCE_REQUIRED") next = "补齐计数证据，再验证需要计数的结论。";
  else if (code === "TASK_REQUIREMENTS_UNMET") next = "核对原请求、输入与权限，只补齐尚未完成的要求。";
  else if (code === "TOOL_ROUND_LIMIT_EXCEEDED") next = "先核对已完成的步骤，缩小剩余任务后再继续。";
  else if (code && ["COMPUTER_MEMORY_INSUFFICIENT", "COMPUTER_MEMORY_UNAVAILABLE", "COMPUTER_DESKTOP_UNAVAILABLE", "ENVIRONMENT_UNAVAILABLE", "BROWSER_UNAVAILABLE", "COMPUTER_USER_CONTROLLED"].includes(code)) {
    next = "先在电脑面板检查资源、连接与控制权，恢复后重新观察实际状态。";
    retryable = false;
  } else if (known?.retryable) next = "检查连接或服务状态；可重试当前步骤，保留的结果需先核对。";
  return { summary: known?.safeMessage ?? (code === "APP_INTERRUPTED" ? "运行被应用中断，没有自动重新发送。" : "执行未完成，请核对已有工具记录与技术详情。"), next, retryable };
}

export function hasUnconfirmedEffect(invocations: ToolInvocation[]): boolean {
  return invocations.some(item => !["pure", "read-local", "read-remote"].includes(item.effectClass) &&
    (["interrupted-unknown", "dispatching", "running", "failed"].includes(item.state) ||
      item.state === "cancelled" && (item.startedAt !== null || item.attemptCount > 0)));
}

export function canRetryRuntime(run: Pick<RuntimeRun, "route" | "state" | "lastErrorCode"> | null | undefined, invocations: ToolInvocation[], fallbackCode?: string | null): boolean {
  if (run && ["host-mcp", "host-outbound"].includes(run.route) || hasUnconfirmedEffect(invocations)) return false;
  // Explicitly cancelled/interrupted read-only work retains its existing manual
  // regeneration path. Unknown mutations above can never use that path.
  if (run && ["cancelled", "interrupted"].includes(run.state)) return true;
  return failureRecovery(run?.lastErrorCode ?? fallbackCode).retryable;
}
