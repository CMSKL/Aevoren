import type { ErrorDomain } from "./contracts";

// Persisted Runtime codes use these same safe descriptions in Main and Renderer.
export const RUN_FAILURE_ERRORS = {
  COMPUTER_MEMORY_INSUFFICIENT: { domain: "tool", retryable: true, safeMessage: "当前Docker内存预算不足，无法安全启动更多电脑。", allowedDetailKeys: ["requiredMiB", "availableMiB"] },
  COMPUTER_MEMORY_UNAVAILABLE: { domain: "tool", retryable: true, safeMessage: "无法核实当前Docker内存预算，请检查引擎及未限定内存的容器后重试。", allowedDetailKeys: [] },
  BROWSER_UNAVAILABLE: { domain: "tool", retryable: true, safeMessage: "浏览器伴随环境尚未就绪，请检查运行状态。", allowedDetailKeys: [] },
  COMPUTER_DESKTOP_UNAVAILABLE: { domain: "tool", retryable: false, safeMessage: "桌面画面或窗口操作未完成，请检查电脑连接与实际窗口状态。", allowedDetailKeys: [] },
  COMPUTER_USER_CONTROLLED: { domain: "tool", retryable: false, safeMessage: "电脑保留着人工接管状态，AI 的输入和观察已暂停。请在电脑面板点击“交给 AI”后重试。", allowedDetailKeys: [] },
  ENVIRONMENT_UNAVAILABLE: { domain: "tool", retryable: true, safeMessage: "Docker 或环境 Worker 未就绪，请查看执行环境状态。", allowedDetailKeys: ["reason"] },
  TOOL_ROUND_LIMIT_EXCEEDED: { domain: "tool", retryable: false, safeMessage: "工具调用次数已达到本次运行上限。", allowedDetailKeys: [] },
  TASK_REQUIREMENTS_UNMET: { domain: "tool", retryable: true, safeMessage: "任务尚未完成：必要的工具执行或成果验证未通过，成功结果仍然保留。", allowedDetailKeys: ["requirement"] },
  MEASUREMENT_EVIDENCE_REQUIRED: { domain: "tool", retryable: true, safeMessage: "没有执行确定性计数工具，长度结论未标记完成。", allowedDetailKeys: ["requirement"] },
  NETWORK_TOOL_UNAVAILABLE: { domain: "tool", retryable: true, safeMessage: "实时数据服务当前不可用。", allowedDetailKeys: ["status"] },
  NETWORK_TOOL_TIMEOUT: { domain: "tool", retryable: true, safeMessage: "实时数据查询超时。", allowedDetailKeys: [] },
  NETWORK_TOOL_RESPONSE_INVALID: { domain: "tool", retryable: true, safeMessage: "实时数据服务返回了无法验证的结果。", allowedDetailKeys: [] },
  MODEL_HOST_TOOL_UNAVAILABLE: { domain: "provider", retryable: true, safeMessage: "模型的工具连接未能建立，请重试。当前文件未被修改。", allowedDetailKeys: [] },
  MODEL_QUOTA_EXCEEDED: { domain: "provider", retryable: true, safeMessage: "模型服务额度不足或已达到使用上限，请检查账户额度后重试。", allowedDetailKeys: [] },
  MODEL_CONNECTION_FAILED: { domain: "provider", retryable: true, safeMessage: "无法连接模型服务。", allowedDetailKeys: ["status"] },
  MODEL_CONNECTION_TIMEOUT: { domain: "provider", retryable: true, safeMessage: "连接模型服务超时。", allowedDetailKeys: [] },
  MODEL_FIRST_EVENT_TIMEOUT: { domain: "provider", retryable: true, safeMessage: "模型长时间没有开始返回内容。", allowedDetailKeys: [] },
  MODEL_STREAM_IDLE_TIMEOUT: { domain: "provider", retryable: true, safeMessage: "模型流式回复已停止响应。", allowedDetailKeys: [] },
  MODEL_RUN_TIMEOUT: { domain: "provider", retryable: true, safeMessage: "模型运行超过最长时间。", allowedDetailKeys: [] },
  MODEL_STREAM_INVALID: { domain: "provider", retryable: true, safeMessage: "模型返回了无法解析的流式数据。", allowedDetailKeys: [] },
  MODEL_STREAM_TRUNCATED: { domain: "provider", retryable: true, safeMessage: "模型回复在完成前中断。", allowedDetailKeys: [] },
  MODEL_TRANSPORT_ERROR: { domain: "provider", retryable: true, safeMessage: "模型连接意外中断。", allowedDetailKeys: [] },
} as const satisfies Record<string, { domain: ErrorDomain; retryable: boolean; safeMessage: string; allowedDetailKeys: readonly string[] }>;
