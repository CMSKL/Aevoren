import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRepository } from "./database";
import { BrowserMediaStore } from "./browser-media-store";
import { HostComputerService, type HostComputerPlatform } from "./host-computer-service";
import { ComputerTaskService } from "./computer-task-service";
import { withHostComputer } from "./computer-target-gateway";
import type { ModelProvider } from "./model";
import type { ComputerTask } from "@shared/computer-task-contracts";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); vi.useRealTimers(); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-host-computer-")), repository = new AppRepository(":memory:");
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }), () => repository.close());
  const { bot, session } = repository.createBot();
  const target = { kind: "app" as const, pid: 123, startedAt: 1234, windowId: 456, appName: "Fixture", title: "Test" };
  const task = { hostTarget: target, id: randomUUID(), sessionId: session.id, executorBotId: bot.id, target: "mac" } as ComputerTask;
  let permitted = true;
  const context = { kind: "app" as const, target, x: 0, y: 0, width: 2000, height: 1000 };
  const platform: HostComputerPlatform = { status: () => ({ supported: true, helperAvailable: true, screenPermission: permitted ? "granted" : "denied", accessibility: permitted }), permission: vi.fn(async () => {}),
    listTargets: vi.fn(async () => [target]), capture: vi.fn(async () => ({ bytes: Buffer.from("controlled adapter bytes, not real screenshot evidence"), width: 1000, height: 500, context })), input: vi.fn(async () => {}) };
  const service = new HostComputerService(repository, platform, new BrowserMediaStore(directory));
  const enable = async (): Promise<void> => { await service.save({ ...service.configuration(), enabled: true, target: "mac", hostTarget: target }); await service.control({ owner: "ai", expectedEpoch: service.status().epoch }); };
  return { repository, task, platform, service, enable, target, directory, permissions(value: boolean) { permitted = value; } };
}
function proof(result: Awaited<ReturnType<HostComputerService["prepare"]>>): Record<string, unknown> {
  const media = result.images![0]!.reference as unknown as { observationId: string; controlEpoch: number };
  return { expectedEpoch: media.controlEpoch, observationId: media.observationId };
}
describe("host Mac boundary (simulated platform, real SQLite/CAS)", () => {
  it("defaults to builtin, keeps host access opt-in, and preserves a conflicting settings draft", async () => {
    const f = fixture(); expect(f.service.configuration()).toEqual({ version: 1, target: "builtin", enabled: false, hostTarget: null });
    await expect(f.service.prepare(f.task, new AbortController().signal)).rejects.toMatchObject({ code: "HOST_COMPUTER_PERMISSION" });
    await f.enable(); await expect(f.service.save({ version: 1, target: "builtin", enabled: false, hostTarget: null })).rejects.toMatchObject({ code: "COMPUTER_TASK_CONFLICT" });
    expect(f.service.configuration().target).toBe("mac");
  });
  it("does not infer a target for old tasks or an enabled configuration without a selected window", async () => {
    const f = fixture(); await f.service.save({ ...f.service.configuration(), enabled: true, target: "mac" });
    await expect(f.service.control({ owner: "ai", expectedEpoch: f.service.status().epoch })).rejects.toMatchObject({ code: "HOST_COMPUTER_TARGET_REQUIRED" });
    await f.enable();
    await expect(f.service.prepare({ ...f.task, hostTarget: undefined }, new AbortController().signal)).rejects.toMatchObject({ code: "HOST_COMPUTER_TARGET_REQUIRED" });
    expect(f.platform.capture).not.toHaveBeenCalled();
  });
  it("revokes the old window on a target change without redirecting its task", async () => {
    const f = fixture(); await f.enable(); const signal = new AbortController().signal;
    const second = { ...f.target, pid: 789, windowId: 890 }; f.platform.listTargets = vi.fn(async () => [second]);
    await f.service.save({ ...f.service.configuration(), hostTarget: second });
    expect(f.service.status().owner).toBe("user");
    await f.service.control({ owner: "ai", expectedEpoch: f.service.status().epoch });
    await expect(f.service.prepare(f.task, signal)).rejects.toMatchObject({ code: "HOST_COMPUTER_TARGET_CHANGED" });
    expect(f.platform.capture).not.toHaveBeenCalled();
    expect(f.service.hostTarget()).toEqual(second);
  });
  it("aborts a pending observation on takeover before any pixels can be published", async () => {
    const f = fixture(); await f.enable(); let aborted = false;
    f.platform.capture = vi.fn(async (_target, signal) => new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true })));
    const pending = f.service.prepare(f.task, new AbortController().signal), rejected = expect(pending).rejects.toBeDefined();
    await f.service.control({ owner: "user", expectedEpoch: f.service.status().epoch }); await rejected;
    expect(aborted).toBe(true); expect(f.platform.input).not.toHaveBeenCalled();
  });
  it("uses only the authorized browser channel without native permissions, and revokes stale images", async () => {
    const f = fixture(); f.permissions(false);
    const target = { kind: "browser" as const, connectionId: "test-connection", tabId: 4, title: "Controlled", url: "https://example.test/" };
    let documentId = "one", shared = true;
    const bridge = { status: () => ({ connected: true }), listTargets: async () => [target],
      isAuthorized: (_target: unknown, context?: { documentId: string }) => shared && (!context || context.documentId === documentId),
      capture: vi.fn(async () => ({ bytes: Buffer.from("fixture image"), width: 200, height: 100, context: { kind: "browser" as const, target, documentId, x: 0, y: 0, width: 200, height: 100 } })),
      input: vi.fn(async () => {}), read: vi.fn(async () => ({ text: "fixture" })), navigate: vi.fn(async () => { documentId = "two"; }), revoke: vi.fn(async () => { shared = false; }) };
    const service = new HostComputerService(f.repository, f.platform, new BrowserMediaStore(f.directory), bridge as never);
    await service.save({ ...service.configuration(), target: "mac", enabled: true, hostTarget: target });
    await service.control({ owner: "ai", expectedEpoch: service.status().epoch });
    const task = { ...f.task, hostTarget: target }, signal = new AbortController().signal, frame = await service.prepare(task, signal);
    expect(frame.images![0]!.isAuthorized()).toBe(true);
    const navigated = await service.execute(task, "browser.navigate", { ...proof(frame), url: "https://example.test/next" }, signal);
    expect(frame.images![0]!.isAuthorized()).toBe(false); expect(navigated.images![0]!.isAuthorized()).toBe(true);
    let finishCleanup!: () => void;
    service.setControlLifecycle(async () => new Promise<void>(resolve => { finishCleanup = resolve; }));
    const revoking = service.revokeBrowser();
    expect(shared).toBe(false); expect(navigated.images![0]!.isAuthorized()).toBe(false);
    await expect(service.control({ owner: "ai", expectedEpoch: service.status().epoch })).rejects.toMatchObject({ code: "HOST_COMPUTER_BUSY" });
    await expect(service.execute(task, "computer.click", { ...proof(navigated), x: 1, y: 1 }, signal)).rejects.toMatchObject({ code: "HOST_BROWSER_UNAVAILABLE" });
    finishCleanup(); await revoking;
    expect(f.platform.capture).not.toHaveBeenCalled(); expect(f.platform.input).not.toHaveBeenCalled();
  });
  it("does not restore AI control while a previous takeover is still cleaning up", async () => {
    const f = fixture(); await f.enable(); let finish!: () => void;
    f.service.setControlLifecycle(async () => new Promise<void>(resolve => { finish = resolve; }));
    const taking = f.service.control({ owner: "user", expectedEpoch: f.service.status().epoch });
    await expect(f.service.control({ owner: "ai", expectedEpoch: f.service.status().epoch })).rejects.toMatchObject({ code: "HOST_COMPUTER_BUSY" });
    expect(f.service.status().owner).toBe("user"); finish(); await taking;
  });
  it("does not issue a late pairing code after a newer revoke", async () => {
    const f = fixture(), bridge = { status: () => ({ connected: false }), revoke: vi.fn(async () => {}), pair: vi.fn(async () => ({ code: "must-not-issue" })) };
    const service = new HostComputerService(f.repository, f.platform, new BrowserMediaStore(f.directory), bridge as never);
    const pending: Array<() => void> = []; service.setControlLifecycle(async () => new Promise<void>(resolve => pending.push(resolve)));
    const pairing = service.pairBrowser(), rejected = expect(pairing).rejects.toMatchObject({ code: "HOST_BROWSER_PAIRING_INVALID" });
    const revoking = service.revokeBrowser(); pending.forEach(resolve => resolve());
    await rejected; await revoking; expect(bridge.pair).not.toHaveBeenCalled();
  });
  it("scales screenshot coordinates to real screen points and returns a new authorized frame after action", async () => {
    const f = fixture(); await f.enable(); const signal = new AbortController().signal;
    const before = await f.service.prepare(f.task, signal);
    const after = await f.service.execute(f.task, "computer.click", { ...proof(before), x: 120, y: 90 }, signal);
    expect(f.platform.input).toHaveBeenCalledWith("click", expect.objectContaining({ x: 240, y: 180 }), expect.objectContaining({ target: expect.objectContaining({ pid: 123, windowId: 456 }) }), expect.any(AbortSignal));
    expect(before.images![0]!.isAuthorized()).toBe(false); expect(after.images![0]!.isAuthorized()).toBe(true);
    await f.service.execute(f.task, "computer.type", { ...proof(after), x: 50, y: 60, text: "Explicit target", replace: true }, signal);
    expect(f.platform.input).toHaveBeenLastCalledWith("type", expect.objectContaining({ x: 100, y: 120 }), expect.anything(), expect.any(AbortSignal));
  });
  it("does not reuse a click anchor after scrolling before a text operation", async () => {
    const f = fixture(); await f.enable(); const signal = new AbortController().signal;
    const initial = await f.service.prepare(f.task, signal);
    const clicked = await f.service.execute(f.task, "computer.click", { ...proof(initial), x: 5, y: 10 }, signal);
    const scrolled = await f.service.execute(f.task, "computer.scroll", { ...proof(clicked), x: 5, y: 10, deltaY: 50, deltaX: 0 }, signal);
    await f.service.execute(f.task, "computer.type", { ...proof(scrolled), text: "draft" }, signal);
    expect(vi.mocked(f.platform.input).mock.calls.at(-1)?.[1]).not.toHaveProperty("x");
    expect(vi.mocked(f.platform.input).mock.calls.at(-1)?.[1]).not.toHaveProperty("y");
  });
  it("rejects positions outside the current captured frame before sending input", async () => {
    const f = fixture(); await f.enable(); const signal = new AbortController().signal, frame = await f.service.prepare(f.task, signal);
    await expect(f.service.execute(f.task, "computer.click", { ...proof(frame), x: 1000, y: 10 }, signal)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(f.service.execute(f.task, "computer.drag", { ...proof(frame), path: [{ x: 10, y: 10 }, { x: 10, y: 500 }] }, signal)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(f.platform.input).not.toHaveBeenCalled();
  });
  it("revokes frames and interrupts input immediately on takeover, resuming only after explicit return", async () => {
    const f = fixture(); await f.enable(); const signal = new AbortController().signal, frame = await f.service.prepare(f.task, signal);
    let aborted = false;
    f.platform.input = vi.fn(async (_operation, _input, _context, signal) => new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true })));
    const action = f.service.execute(f.task, "computer.drag", { ...proof(frame), path: [{ x: 1, y: 1 }, { x: 100, y: 100 }] }, signal);
    const rejected = expect(action).rejects.toBeDefined();
    const lifecycle = vi.fn(async () => { expect(frame.images![0]!.isAuthorized()).toBe(false); expect(aborted).toBe(true); await f.service.release(f.task); });
    f.service.setControlLifecycle(lifecycle);
    await f.service.control({ owner: "user", expectedEpoch: f.service.status().epoch }); await rejected;
    expect(lifecycle).toHaveBeenCalledWith(f.task, "user");
    await expect(f.service.prepare(f.task, signal)).rejects.toMatchObject({ code: "COMPUTER_USER_CONTROLLED" });
    await f.service.control({ owner: "ai", expectedEpoch: f.service.status().epoch });
    expect(lifecycle).toHaveBeenLastCalledWith(f.task, "ai");
  });
  it("rejects another task's lease, old observations, invalid scope and revoked system permissions without input", async () => {
    const f = fixture(); await f.enable(); const signal = new AbortController().signal, frame = await f.service.prepare(f.task, signal);
    await expect(f.service.prepare({ ...f.task, id: randomUUID() }, signal)).rejects.toMatchObject({ code: "HOST_COMPUTER_BUSY" });
    await expect(f.service.execute(f.task, "computer.click", { ...proof(frame), observationId: randomUUID(), x: 1, y: 1 }, signal)).rejects.toMatchObject({ code: "BROWSER_OBSERVATION_REQUIRED" });
    f.permissions(false);
    expect(frame.images![0]!.isAuthorized()).toBe(false);
    await expect(f.service.execute(f.task, "computer.click", { ...proof(frame), x: 1, y: 1 }, signal)).rejects.toMatchObject({ code: "HOST_COMPUTER_PERMISSION" });
    expect(f.platform.input).not.toHaveBeenCalled();
  });
  it("does not retry an unknown input and requires fresh pixels after release/restart", async () => {
    const f = fixture(); await f.enable(); const signal = new AbortController().signal, frame = await f.service.prepare(f.task, signal);
    f.platform.input = vi.fn(async () => { throw new Error("connection lost after effect"); });
    await expect(f.service.execute(f.task, "computer.click", { ...proof(frame), x: 1, y: 1 }, signal)).rejects.toThrow("connection lost");
    await expect(f.service.execute(f.task, "computer.click", { ...proof(frame), x: 1, y: 1 }, signal)).rejects.toMatchObject({ code: "BROWSER_OBSERVATION_REQUIRED" });
    expect(f.platform.input).toHaveBeenCalledTimes(1);
    await f.service.release(f.task); expect(frame.images![0]!.isAuthorized()).toBe(false);
    const reopened = new HostComputerService(f.repository, f.platform, new BrowserMediaStore(tmpdir()));
    expect(reopened.configuration().target).toBe("mac"); expect(reopened.status().owner).toBe("user");
  });
  it("pauses and resumes model verification before any task acquires the Mac lease", async () => {
    const f = fixture(); await f.enable();
    const selection = { providerInstanceId: "openai-compatible.default", modelId: "controlled-computer-model" };
    const provider: ModelProvider = { run: async function* () { yield { type: "delta", text: "No screen action requested" }; }, testConnection: async () => {} };
    const providers = { get: async () => ({ id: selection.providerInstanceId, version: 1, status: "available" }), isSupported: () => true,
      createProvider: () => provider, getCapabilities: () => ({ toolImageInput: true }) };
    let attempts = 0, aborted = false;
    const tasks = new ComputerTaskService(f.repository, providers as never, withHostComputer({ definitions: [], schemas: {} } as never, f.service), undefined, async (_provider, signal) => {
      if (attempts++ > 0) return;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
      signal.throwIfAborted();
    });
    tasks.saveConfiguration({ expectedVersion: tasks.configuration().version, selection });
    f.service.setControlLifecycle((scope, owner) => tasks.controlChanged(scope, owner, "mac"));
    try {
      const task = await tasks.start({ sessionId: f.task.sessionId, executorBotId: f.task.executorBotId, goal: "Observe after verification", clientNonce: randomUUID() });
      const id = { sessionId: task.sessionId, executorBotId: task.executorBotId, id: task.id };
      await expect.poll(() => attempts).toBe(1);
      expect(f.service.status().busy).toBe(false);
      await f.service.control({ owner: "user", expectedEpoch: f.service.status().epoch });
      expect(aborted).toBe(true); expect(tasks.get(id).task.state).toBe("waiting_user"); expect(f.platform.capture).not.toHaveBeenCalled();
      await f.service.control({ owner: "ai", expectedEpoch: f.service.status().epoch });
      await expect.poll(() => tasks.get(id).task.state).toBe("paused");
      expect(attempts).toBe(2); expect(f.platform.capture).toHaveBeenCalledOnce();
    } finally { await tasks.close(); }
  });
});
