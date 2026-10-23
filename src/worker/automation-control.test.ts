import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WORKER_AUTOMATION_PAUSE_CAPABILITY } from "@shared/environment-contracts";
import type { WorkerExecutionRequest } from "@shared/environment-contracts";
import { ExecutionWorker } from "./execution-worker";
import { createWorkerServer } from "./server";

const input = (kind: "foreground" | "background" = "foreground"): WorkerExecutionRequest => ({ id: randomUUID(), sessionId: randomUUID(), runtimeRunId: null, kind, command: "must not spawn", cwd: "." });
async function fixture(run: (worker: ExecutionWorker) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "aevoren-automation-control-"));
  const worker = new ExecutionWorker({ environmentId: randomUUID(), stateDirectory: directory, workspaceDirectory: directory, helperPath: "not-run-in-host-fixture" });
  try { await run(worker); }
  finally { await worker.close(); await rm(directory, { recursive: true, force: true }); }
}

describe("foreground automation admission and authenticated control", () => {
  it("fences an admitted foreground request before spawn, waits for it and serializes cancellation", async () => fixture(async worker => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const file = vi.spyOn(worker, "file").mockImplementation(async () => { await gate; return { path: "." }; });
    const request = input(), started = worker.start(request).catch(error => error);
    await expect.poll(() => file.mock.calls.length).toBe(1);
    const paused = worker.controlAutomation(true);
    let cancelled = false;
    const cancellation = worker.cancel(request.id).then(value => { cancelled = true; return value; });
    await expect(worker.start(input())).rejects.toMatchObject({ code: "WORKER_AUTOMATION_PAUSED" });
    expect(() => worker.automationState()).toThrowError(expect.objectContaining({ code: "WORKER_AUTOMATION_CHANGING" }));
    expect(cancelled).toBe(false);
    release();
    expect(await started).toMatchObject({ code: "WORKER_AUTOMATION_PAUSED" });
    expect(await paused).toEqual({ paused: true });
    expect(await cancellation).toMatchObject({ id: request.id, state: "cancelled", pending: true });
    expect(worker.store.list()).toEqual([]);
  }));

  it("does not wait on independent background admission and preserves ordered control requests", async () => fixture(async worker => {
    let reject!: (error: Error) => void;
    const backgroundGate = new Promise<never>((_, rejectPromise) => { reject = rejectPromise; });
    const file = vi.spyOn(worker, "file").mockImplementation(() => backgroundGate);
    const background = worker.start(input("background")).catch(error => error);
    await expect.poll(() => file.mock.calls.length).toBe(1);
    try {
      const first = worker.controlAutomation(true), second = worker.controlAutomation(false);
      expect(await first).toEqual({ paused: true }); expect(await second).toEqual({ paused: false });
      expect(worker.automationState()).toEqual({ paused: false });
    } finally { reject(new Error("Controlled background fixture released before spawn")); await background; }
  }));

  it("keeps the admission fence after an unconfirmed transition times out", async () => fixture(async worker => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const file = vi.spyOn(worker, "file").mockImplementation(async () => { await gate; return { path: "." }; });
    const admitted = worker.start(input()).catch(error => error);
    await expect.poll(() => file.mock.calls.length).toBe(1);
    vi.useFakeTimers();
    try {
      const paused = worker.controlAutomation(true).catch(error => error);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await paused).toMatchObject({ code: "WORKER_AUTOMATION_CONTROL_TIMEOUT" });
      expect(() => worker.automationState()).toThrowError(expect.objectContaining({ code: "WORKER_AUTOMATION_CONTROL_TIMEOUT" }));
      await expect(worker.start(input())).rejects.toMatchObject({ code: "WORKER_AUTOMATION_PAUSED" });
    } finally { vi.useRealTimers(); release(); await admitted; }
  }));

  it("requires the Worker token, validates control input and advertises the additive capability", async () => fixture(async worker => {
    const token = "a".repeat(64), server = createWorkerServer(worker, token);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const request = (path: string, method = "GET", body?: unknown, authorized = true) => fetch(url + path, { method, headers: { authorization: authorized ? `Bearer ${token}` : "Bearer wrong", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try {
      expect((await request("/v1/automation/control", "POST", { paused: true }, false)).status).toBe(401);
      expect(worker.automationState()).toEqual({ paused: false });
      expect((await request("/v1/automation/control", "POST", { paused: "true" })).status).toBe(400);
      expect((await request("/v1/automation/control", "POST", { paused: true, extra: true })).status).toBe(400);
      expect(await (await request("/v1/automation/control", "POST", { paused: true })).json()).toEqual({ paused: true });
      expect(await (await request("/v1/automation/control")).json()).toEqual({ paused: true });
      expect((await (await request("/v1/health")).json()).capabilities).toContain(WORKER_AUTOMATION_PAUSE_CAPABILITY);
      expect(await (await request("/v1/automation/control", "POST", { paused: false })).json()).toEqual({ paused: false });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }));
});
