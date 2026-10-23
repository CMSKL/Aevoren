import type { ToolInvocation } from "./contracts";

/** Public-read automation never includes files, clipboard, MCP or writes. */
export function isPublicReadTool(kind: ToolInvocation["toolKind"]): boolean {
  return ["web-search", "web-fetch", "weather-current", "time-now"].includes(kind);
}
