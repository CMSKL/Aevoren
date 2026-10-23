import { describe, expect, it } from "vitest";
import type { RuntimeRun, ToolInvocation } from "@shared/contracts";
import { canRetryRuntime } from "./run-failure-recovery";

const run = { route: "fake", state: "failed", lastErrorCode: "MODEL_CONNECTION_TIMEOUT" } satisfies Pick<RuntimeRun, "route" | "state" | "lastErrorCode">;
const unknown = { effectClass: "computer-control", state: "interrupted-unknown", startedAt: "2026-10-21", attemptCount: 1 } as ToolInvocation;

describe("all existing Runtime retry entries", () => {
  it("keeps safe provider and pre-acceptance Room retries", () => {
    expect(canRetryRuntime(run, [])).toBe(true);
    expect(canRetryRuntime(null, [], "MODEL_CONNECTION_FAILED")).toBe(true);
  });
  it("rejects the same known resource and budget failures in a menu as in a card", () => {
    for (const lastErrorCode of ["COMPUTER_MEMORY_INSUFFICIENT", "TOOL_ROUND_LIMIT_EXCEEDED", "UNKNOWN_ERROR"])
      expect(canRetryRuntime({ ...run, lastErrorCode }, [])).toBe(false);
  });
  it.each(["failed", "cancelled", "interrupted"] as const)("protects unknown input in %s regardless of the entry", state => {
    expect(canRetryRuntime({ ...run, state }, [unknown])).toBe(false);
  });
  it.each(["cancelled", "interrupted"] as const)("retains an explicit manual retry of safe %s work", state => {
    expect(canRetryRuntime({ ...run, state, lastErrorCode: "APP_INTERRUPTED" }, [])).toBe(true);
  });
  it.each(["host-mcp", "host-outbound"] as const)("never offers model regeneration for %s", route => {
    expect(canRetryRuntime({ ...run, route }, [])).toBe(false);
  });
});
