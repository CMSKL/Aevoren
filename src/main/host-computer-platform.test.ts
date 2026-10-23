import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostAppContext, HostAppTarget } from "@shared/host-computer-targets";

const calls = vi.hoisted(() => ({ spawn: vi.fn(), screenPermission: vi.fn(() => "granted") }));
vi.mock("node:child_process", () => ({ spawn: calls.spawn }));
vi.mock("electron", () => ({ shell: {}, systemPreferences: { getMediaAccessStatus: calls.screenPermission } }));
import { createMacComputerPlatform } from "./host-computer-platform";

const target: HostAppTarget = { kind: "app", pid: 123, startedAt: 1760000000.25, windowId: 456, appName: "Controlled fixture", title: "Unfocused window" };
const context: HostAppContext = { kind: "app", target, x: 30, y: 40, width: 1440, height: 900 };
const originalPlatform = process.platform;
beforeEach(() => { Object.defineProperty(process, "platform", { value: "darwin" }); calls.screenPermission.mockReturnValue("granted"); });
function child() {
  const process = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(() => true) });
  calls.spawn.mockReturnValueOnce(process);
  return process;
}
function reply(value: unknown) {
  const process = child();
  process.stdin.once("finish", () => { process.emit("spawn"); process.stdout.write(JSON.stringify(value)); process.emit("close", 0, null); });
  return process;
}
function command(process: ReturnType<typeof child>): unknown { return JSON.parse(process.stdin.read().toString("utf8")); }
// A structural JPEG fixture for dimension validation, not real capture evidence.
const pixels = Buffer.from([255, 216, 255, 192, 0, 8, 8, 3, 132, 5, 160, 1, 255, 217]);
const frame = { dataBase64: pixels.toString("base64"), width: 1440, height: 900 };
afterEach(() => { Object.defineProperty(process, "platform", { value: originalPlatform }); vi.clearAllMocks(); });
describe("native Mac helper receipts (simulated child, no screen input)", () => {
  it.each([
    { output: JSON.stringify({ ok: true, context }), code: null, signal: "SIGSEGV" },
    { output: '{"ok":', code: 1, signal: null },
    { output: JSON.stringify({ ok: true, context }), code: 1, signal: null },
  ])("marks an unconfirmed input result unknown: %j", async ({ output, code, signal }) => {
    const process = child(), pending = createMacComputerPlatform("/fixture/helper").input("click", { x: 2, y: 3 }, context, new AbortController().signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: "TOOL_STATE_INVALID" });
    process.emit("spawn"); process.stdout.write(output); process.emit("close", code, signal); await assertion;
    expect(calls.spawn).toHaveBeenCalledTimes(1);
  });
  it.each(["BROWSER_OBSERVATION_REQUIRED", "HOST_COMPUTER_TARGET_CHANGED", "HOST_COMPUTER_ACTION_UNSUPPORTED"])("preserves the helper's explicit rejection before input: %s", async code => {
    const process = child(), pending = createMacComputerPlatform("/fixture/helper").input("click", { x: 2, y: 3 }, context, new AbortController().signal);
    const assertion = expect(pending).rejects.toMatchObject({ code });
    process.emit("spawn"); process.stdout.write(JSON.stringify({ ok: false, code })); process.emit("close", 4, null); await assertion;
  });
  it("accepts a complete receipt only after normal close", async () => {
    const process = child(); let settled = false;
    const pending = createMacComputerPlatform("/fixture/helper").input("click", { x: 2, y: 3 }, context, new AbortController().signal).then(() => { settled = true; });
    process.emit("spawn"); process.stdout.write(JSON.stringify({ ok: true, context })); process.emit("exit", 0, null);
    await Promise.resolve(); expect(settled).toBe(false);
    process.emit("close", 0, null); await pending; expect(settled).toBe(true);
  });
  it("reports a spawn failure without claiming an input was sent", async () => {
    const process = child(), pending = createMacComputerPlatform("/fixture/missing").input("click", { x: 2, y: 3 }, context, new AbortController().signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE" });
    process.emit("error", new Error("ENOENT")); process.emit("close", -2, null); await assertion;
  });
  it("cancellation waits for helper cleanup and does not replay input", async () => {
    const process = child(), controller = new AbortController(); let settled = false;
    const pending = createMacComputerPlatform("/fixture/helper").input("drag", {}, context, controller.signal).catch(error => { settled = true; throw error; });
    const reason = new Error("fixture cancelled"), assertion = expect(pending).rejects.toBe(reason);
    process.emit("spawn"); controller.abort(reason);
    await Promise.resolve(); expect(settled).toBe(false); expect(process.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    process.emit("close", 130, null); await assertion; expect(calls.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("background app targets (simulated helper, no GUI or real input)", () => {
  it("lists explicit process launch and window identities without capturing anything", async () => {
    const process = reply({ ok: true, targets: [target] });
    await expect(createMacComputerPlatform("/fixture/helper").listTargets(new AbortController().signal)).resolves.toEqual([target]);
    expect(command(process)).toEqual({ operation: "listTargets" }); expect(calls.spawn).toHaveBeenCalledOnce();
  });
  it("captures only the selected window between identity and geometry checks", async () => {
    const before = reply({ ok: true, context, accessibility: true }), capture = reply({ ok: true, context, capture: frame }), after = reply({ ok: true, context });
    await expect(createMacComputerPlatform("/fixture/helper").capture(target, new AbortController().signal)).resolves.toEqual({ bytes: pixels, width: 1440, height: 900, context });
    expect(command(before)).toEqual({ operation: "status", target }); expect(command(capture)).toEqual({ operation: "capture", target }); expect(command(after)).toEqual({ operation: "status", target });
  });
  it.each([
    { ...context, x: 99 }, { ...context, width: 1400 }, { ...context, target: { ...target, startedAt: target.startedAt + 1 } },
    { ...context, target: { ...target, pid: 124 } }, { ...context, target: { ...target, windowId: 457 } },
  ])("discards captured pixels after target identity or geometry changes: %j", async changed => {
    reply({ ok: true, context, accessibility: true }); reply({ ok: true, context, capture: frame }); reply({ ok: true, context: changed });
    await expect(createMacComputerPlatform("/fixture/helper").capture(target, new AbortController().signal)).rejects.toMatchObject({ code: "HOST_COMPUTER_TARGET_CHANGED" });
  });
  it("rejects missing or browser targets without starting the native helper", async () => {
    const platform = createMacComputerPlatform("/fixture/helper"), signal = new AbortController().signal;
    await expect(platform.capture(undefined as never, signal)).rejects.toMatchObject({ code: "HOST_COMPUTER_TARGET_REQUIRED" });
    await expect(platform.capture({ kind: "browser", tabId: 1 } as never, signal)).rejects.toMatchObject({ code: "HOST_COMPUTER_ACTION_UNSUPPORTED" });
    await expect(platform.input("click", {}, { kind: "browser", target: { kind: "browser", tabId: 1 } } as never, signal)).rejects.toMatchObject({ code: "HOST_COMPUTER_ACTION_UNSUPPORTED" });
    expect(calls.spawn).not.toHaveBeenCalled();
  });
  it("binds typing and replacement to the supplied window and anchor", async () => {
    const process = reply({ ok: true });
    await createMacComputerPlatform("/fixture/helper").input("type", { text: "fixture", replace: true, x: 120, y: 80, context: "untrusted override" }, context, new AbortController().signal);
    expect(command(process)).toEqual({ operation: "type", text: "fixture", replace: true, x: 120, y: 80, context });
  });
  it("rejects invalid capture bytes and permission denial without a fallback capture", async () => {
    reply({ ok: true, context, accessibility: true }); reply({ ok: true, context, capture: { ...frame, dataBase64: "invalid" } }); reply({ ok: true, context });
    const platform = createMacComputerPlatform("/fixture/helper");
    await expect(platform.capture(target, new AbortController().signal)).rejects.toMatchObject({ code: "BROWSER_MEDIA_INVALID" });
    expect(calls.spawn).toHaveBeenCalledTimes(3);
    calls.screenPermission.mockReturnValue("denied");
    await expect(platform.capture(target, new AbortController().signal)).rejects.toMatchObject({ code: "HOST_COMPUTER_PERMISSION" });
    expect(calls.spawn).toHaveBeenCalledTimes(3);
  });
  it("contains no global input, foreground targeting, clipboard or screen-capture fallback", () => {
    const native = readFileSync(new URL("../native-mac/computer-input.swift", import.meta.url), "utf8");
    expect(native).not.toMatch(/CGEventPost\s*\(|\.post\s*\(\s*tap:|postToPid|cghidEventTap|cgSessionEventTap|CGWarpMouseCursorPosition|CGDisplayMoveCursorToPoint|\.activate\s*\(|kAXRaiseAction|frontmostApplication|NSPasteboard|CGDisplayCreateImage|CGWindowListCreateImage|CGEvent\s*\(source:\s*nil\)/u);
    expect(native).toContain("AXUIElementPerformAction(controls[0], kAXPressAction");
    expect(native).toContain("CFEqual(focusedElement, fields[0])");
    expect(native).toContain("SCContentFilter(desktopIndependentWindow: window)");
    const adapter = readFileSync(new URL("./host-computer-platform.ts", import.meta.url), "utf8");
    expect(adapter).not.toMatch(/desktopCapturer|getPrimaryDisplay|types:\s*\["screen"\]/u);
  });
});
