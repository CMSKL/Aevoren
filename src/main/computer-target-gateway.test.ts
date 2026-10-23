import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BROWSER_OPERATION_SCHEMAS, BROWSER_PRODUCT_OPERATIONS } from "@shared/browser-product";
import type { ComputerTask } from "@shared/computer-task-contracts";
import type { ComputerToolGateway } from "./computer-tool-gateway";
import { withHostComputer } from "./computer-target-gateway";

function fixture() {
  const builtin: ComputerToolGateway = { definitions: BROWSER_PRODUCT_OPERATIONS, schemas: BROWSER_OPERATION_SCHEMAS, assertAI: vi.fn(),
    prepare: vi.fn(async () => ({ result: {} })), execute: vi.fn(async () => ({ result: { target: "builtin" } })), cancel: vi.fn(async () => {}) };
  const host = { target: () => "mac" as const, execute: vi.fn(async () => ({ result: { target: "mac" } })) };
  const gateway = withHostComputer(builtin, host as never);
  const task = { id: randomUUID(), sessionId: randomUUID(), executorBotId: randomUUID(), target: "mac" } as ComputerTask;
  const proof = { expectedEpoch: 1, observationId: randomUUID() };
  return { builtin, host, gateway, task, proof, signal: new AbortController().signal };
}

describe("Mac task tool schemas", () => {
  it("accepts an omitted computer.view input", async () => {
    const f = fixture();
    await expect(f.gateway.execute(f.task, "computer.view", undefined, "step", f.signal)).resolves.toEqual({ result: { target: "mac" } });
    expect(f.host.execute).toHaveBeenCalledExactlyOnceWith(f.task, "computer.view", {}, f.signal);
  });
  it.each(["computer.click", "computer.move", "computer.scroll", "computer.drag"])("accepts coordinates outside the builtin viewport for %s", async operation => {
    const f = fixture(); f.task.hostTarget = { kind: "browser", connectionId: "fixture", tabId: 1, title: "Fixture", url: "https://example.test" }; const input = { ...f.proof, ...(operation === "computer.drag" ? { path: [{ x: 1400, y: 850 }, { x: 1599, y: 999 }] } : { x: 1400, y: 850 }), ...(operation === "computer.scroll" ? { deltaX: 0, deltaY: 100 } : {}) };
    await expect(f.gateway.execute(f.task, operation, input, "step", f.signal)).resolves.toEqual({ result: { target: "mac" } });
    expect(f.host.execute).toHaveBeenCalledOnce();
    const schemas = f.gateway.schemasFor?.(f.task) ?? f.gateway.schemas;
    expect(schemas[operation]!.safeParse(input).success).toBe(true);
    expect(BROWSER_OPERATION_SCHEMAS[operation]!.safeParse(input).success).toBe(false);
  });
  it("does not advertise or dispatch unverified native drag, move or scroll", async () => {
    const f = fixture(); f.task.hostTarget = { kind: "app", pid: 123, startedAt: 1000, windowId: 7, title: "Fixture", appName: "Test" };
    const names = f.gateway.definitionsFor!(f.task).map(item => item.name);
    for (const operation of ["computer.drag", "computer.move", "computer.scroll", "browser.navigate"]) {
      expect(names).not.toContain(operation);
      await expect(f.gateway.execute(f.task, operation, { ...f.proof }, "step", f.signal)).rejects.toMatchObject({ code: "HOST_COMPUTER_ACTION_UNSUPPORTED" });
    }
    expect(f.host.execute).not.toHaveBeenCalled();
  });
  it("preserves builtin routing and rejects invalid Mac coordinates and scope", async () => {
    const f = fixture(), input = { ...f.proof, x: 1400, y: 850 };
    await f.gateway.execute({ ...f.task, target: "builtin" }, "computer.click", input, "step", f.signal);
    expect(f.builtin.execute).toHaveBeenCalledOnce(); expect(f.host.execute).not.toHaveBeenCalled();
    await expect(f.gateway.execute(f.task, "computer.click", { ...input, x: -1 }, "step", f.signal)).rejects.toBeDefined();
    await expect(f.gateway.execute(f.task, "computer.click", { ...input, sessionId: randomUUID() }, "step", f.signal)).rejects.toMatchObject({ code: "BROWSER_SCOPE_INVALID" });
    expect(f.host.execute).not.toHaveBeenCalled();
  });
});
