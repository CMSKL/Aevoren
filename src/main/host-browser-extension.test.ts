import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";
import { HostBrowserBridge, HOST_BROWSER_EXTENSION_ID } from "./host-browser-bridge";

type EventSource = { tabId: number };
type EventParams = { frameId?: string; frame?: { id: string; url: string }; url?: string };
const moduleUrl = pathToFileURL(resolve("browser-extension/commands.mjs")).href;
const { createTabController } = await import(moduleUrl);
function fixture() {
  let event!: (source: EventSource, method: string, params: EventParams) => void;
  const shared: Array<Array<{ tabId: number; documentId: string; ready: boolean }>> = [];
  const sendCommand = vi.fn(async (_target: EventSource, method: string, _params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame-main", url: "https://owned.test/" } } };
    if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 } };
    if (method === "DOM.getNodeForLocation") return { backendNodeId: 1 };
    if (method === "DOM.describeNode") return { node: { nodeName: "INPUT", attributes: ["type", "text"] } };
    if (method === "Page.navigate") { event({ tabId: 7 }, "Page.frameStartedLoading", { frameId: "frame-main" }); event({ tabId: 7 }, "Page.frameNavigated", { frame: { id: "frame-main", url: "https://next.test/" } }); }
    return {};
  });
  const api = { debugger: { sendCommand, attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), onEvent: { addListener: (listener: typeof event) => { event = listener; } }, onDetach: { addListener: vi.fn() } }, tabs: { get: vi.fn(async () => ({ url: "https://owned.test/", title: "Owned fixture" })), onRemoved: { addListener: vi.fn() } } };
  const controller = createTabController(api, (targets: typeof shared[number]) => shared.push(targets));
  const request = (operation: string, arguments_: object = {}) => ({ id: "fixture-request", tabId: 7, documentId: shared.at(-1)![0]!.documentId, deadline: Date.now() + 1000, operation, arguments: arguments_ });
  return { controller, api, sendCommand, shared, request, emit: (method: string, params: EventParams = {}) => event({ tabId: 7 }, method, params) };
}

describe("fixed commands in the background extension (mock CDP)", () => {
  it("rejects unshared tabs and arbitrary CDP names without foreground browser operations", async () => {
    const f = fixture();
    await expect(f.controller.handle({ tabId: 99, deadline: Date.now() + 1000 }, new AbortController().signal)).rejects.toMatchObject({ code: "HOST_BROWSER_TARGET_CHANGED" });
    await f.controller.share(7);
    await expect(f.controller.handle(f.request("Runtime.evaluate"), new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(f.controller.handle(f.request("input", { operation: "key", key: "Control+L" }), new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(f.sendCommand.mock.calls.every(call => call[0].tabId === 7)).toBe(true);
    expect(f.sendCommand.mock.calls.map(call => call[1])).not.toContain("Page.bringToFront");
  });

  it("keeps tab sharing on navigation and rejects the previous document", async () => {
    const f = fixture(); await f.controller.share(7); const old = f.request("read");
    const result = await f.controller.handle(f.request("navigate", { url: "https://next.test/" }), new AbortController().signal);
    expect(f.shared.at(-1)).toHaveLength(1); expect(result.documentId).not.toBe(old.documentId);
    await expect(f.controller.handle(old, new AbortController().signal)).rejects.toMatchObject({ code: "HOST_BROWSER_TARGET_CHANGED" });
    await f.controller.clear();
  });

  it("releases only its own synthetic mouse hold when cancelled after dispatch", async () => {
    const f = fixture(); await f.controller.share(7); const abort = new AbortController(), original = f.sendCommand.getMockImplementation()!;
    f.sendCommand.mockImplementation(async (...args) => { const result = await original(...args); if (args[1] === "Input.dispatchMouseEvent" && args[2].type === "mousePressed") abort.abort(); return result; });
    await expect(f.controller.handle(f.request("input", { operation: "click", x: 20, y: 20 }), abort.signal)).rejects.toThrow();
    expect(f.sendCommand.mock.calls.filter(call => call[1] === "Input.dispatchMouseEvent").map(call => call[2].type)).toEqual(["mousePressed", "mouseReleased"]);
    await f.controller.clear();
  });

  it("reports failed synthetic release instead of acknowledging a successful stop", async () => {
    const f = fixture(); await f.controller.share(7); const abort = new AbortController(), original = f.sendCommand.getMockImplementation()!;
    f.sendCommand.mockImplementation(async (...args) => {
      if (args[1] === "Input.dispatchMouseEvent" && args[2].type === "mouseReleased") throw new Error("Fixture transport lost");
      const result = await original(...args); if (args[1] === "Input.dispatchMouseEvent" && args[2].type === "mousePressed") abort.abort(); return result;
    });
    await expect(f.controller.handle(f.request("input", { operation: "click", x: 20, y: 20 }), abort.signal)).rejects.toMatchObject({ code: "HOST_BROWSER_UNAVAILABLE", cleanupFailed: true });
    await expect(f.controller.clear()).rejects.toMatchObject({ cleanupFailed: true });
    expect(f.api.debugger.detach).toHaveBeenCalledWith({ tabId: 7 });
  });

  it("refuses file-picker clicks and revokes a target when a page opens a native dialog", async () => {
    const f = fixture(); await f.controller.share(7); const original = f.sendCommand.getMockImplementation()!;
    f.sendCommand.mockImplementation(async (...args) => args[1] === "DOM.describeNode" ? { node: { nodeName: "INPUT", attributes: ["type", "file"] } } : original(...args));
    await expect(f.controller.handle(f.request("input", { operation: "click", x: 20, y: 20 }), new AbortController().signal)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(f.sendCommand.mock.calls.some(call => call[1] === "Input.dispatchMouseEvent")).toBe(false);
    f.emit("Page.javascriptDialogOpening"); expect(f.controller.list()).toEqual([]);
    await f.controller.clear();
  });
});

it.skipIf(process.env.AEVOREN_HOST_BROWSER_ACCEPTANCE !== "1")("uses the real MV3 extension in an isolated headless Chromium without activating the shared tab", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-browser-extension-")), bridge = new HostBrowserBridge({ read: () => null, write: () => {} });
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(request.url === "/next" ? "<title>Next fixture</title><h1>NAVIGATION_REAL</h1>" : '<title>Background fixture</title><h1>BACKGROUND_FIXTURE</h1><input id="field" aria-label="Fixture input" oninput="document.getElementById(\'receipt\').textContent=this.value"><p id="receipt"></p><input id="file" type="file">');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture bind failed");
  const url = `http://127.0.0.1:${address.port}`, extensionPath = resolve("browser-extension");
  const context = await chromium.launchPersistentContext(directory, { channel: "chromium", headless: true, viewport: { width: 1000, height: 700 }, args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const page = await context.newPage(); await page.goto(url);
    const popup = await context.newPage(); await popup.goto(`chrome-extension://${HOST_BROWSER_EXTENSION_ID}/popup.html`);
    const pairing = await bridge.pair(); await popup.locator("#endpoint").fill(pairing.endpoint); await popup.locator("#code").fill(pairing.code); await popup.locator("#pair button").click();
    await vi.waitFor(() => expect(bridge.status().connected).toBe(true), { timeout: 10000 });
    const tabId = await worker.evaluate(async url => { const api = (globalThis as unknown as { chrome: { tabs: { query(input: object): Promise<Array<{ id: number }>> } } }).chrome; return (await api.tabs.query({ url: `${url}/` }))[0]!.id; }, url);
    const shared = await popup.evaluate(tabId => (globalThis as unknown as { chrome: { runtime: { sendMessage(input: object): Promise<{ ok: boolean }> } } }).chrome.runtime.sendMessage({ type: "share", tabId }), tabId);
    expect(shared).toMatchObject({ ok: true });
    await vi.waitFor(async () => expect(await bridge.listTargets(AbortSignal.timeout(1000))).toHaveLength(1));
    const [target] = await bridge.listTargets(AbortSignal.timeout(1000));
    const activeTab = () => worker.evaluate(async () => (await (globalThis as unknown as { chrome: { tabs: { query(input: object): Promise<Array<{ id: number }>> } } }).chrome.tabs.query({ active: true, currentWindow: true }))[0]!.id);
    const activeBefore = await activeTab(); expect(activeBefore).not.toBe(tabId);
    const capture = await bridge.capture(target!, AbortSignal.timeout(5000)); expect(capture.bytes.length).toBeGreaterThan(1000);
    const box = await page.locator("#field").boundingBox(); if (!box) throw new Error("fixture input missing");
    await bridge.input("click", { x: box.x + 10, y: box.y + 10 }, capture.context, AbortSignal.timeout(5000));
    await bridge.input("type", { text: "BACKGROUND_INPUT_REAL" }, capture.context, AbortSignal.timeout(5000));
    expect(await page.locator("#field").inputValue()).toBe("BACKGROUND_INPUT_REAL");
    expect(await bridge.read(target!, AbortSignal.timeout(5000))).toMatchObject({ text: expect.stringContaining("BACKGROUND_INPUT_REAL") });
    expect(await activeTab()).toBe(activeBefore);
    // Test-only gate delays the response after a real tab-scoped mouse-down. It never touches a user profile.
    await worker.evaluate(() => {
      const scope = globalThis as unknown as { chrome: { debugger: { sendCommand(target: object, method: string, params: { type?: string }): Promise<unknown> } }; fixtureGate: { down: boolean; releases: number; resume?: () => void } };
      const original = scope.chrome.debugger.sendCommand.bind(scope.chrome.debugger); scope.fixtureGate = { down: false, releases: 0 };
      scope.chrome.debugger.sendCommand = async (target, method, params) => {
        const result = await original(target, method, params);
        if (method === "Input.dispatchMouseEvent" && params.type === "mousePressed") { scope.fixtureGate.down = true; await new Promise<void>(resolve => { scope.fixtureGate.resume = resolve; }); }
        if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") scope.fixtureGate.releases++;
        return result;
      };
    });
    const cancellation = new AbortController(); let cancelledSettled = false;
    const cancelled = bridge.input("click", { x: box.x + 10, y: box.y + 10 }, capture.context, cancellation.signal).finally(() => { cancelledSettled = true; });
    const cancelledResult = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(async () => expect(await worker.evaluate(() => (globalThis as unknown as { fixtureGate: { down: boolean } }).fixtureGate.down)).toBe(true));
    cancellation.abort(); await worker.evaluate(() => undefined); expect(cancelledSettled).toBe(false);
    await worker.evaluate(() => (globalThis as unknown as { fixtureGate: { resume: () => void } }).fixtureGate.resume()); await cancelledResult;
    expect(await worker.evaluate(() => (globalThis as unknown as { fixtureGate: { releases: number } }).fixtureGate.releases)).toBe(1); expect(await activeTab()).toBe(activeBefore);
    const fileBox = await page.locator("#file").boundingBox(); if (!fileBox) throw new Error("fixture file input missing");
    await expect(bridge.input("click", { x: fileBox.x + 10, y: fileBox.y + 10 }, capture.context, AbortSignal.timeout(5000))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await bridge.navigate(target!, `${url}/next`, capture.context, AbortSignal.timeout(10000));
    expect(bridge.isAuthorized(target!, capture.context)).toBe(false); expect(bridge.isAuthorized(target!)).toBe(true);
    expect(await bridge.read(target!, AbortSignal.timeout(5000))).toMatchObject({ text: expect.stringContaining("NAVIGATION_REAL") });
    const next = await bridge.capture(target!, AbortSignal.timeout(5000)); expect(next.bytes.length).toBeGreaterThan(1000); expect(await activeTab()).toBe(activeBefore);
    await bridge.revoke(); expect(bridge.status().connected).toBe(false); expect(bridge.isAuthorized(target!)).toBe(false);
    expect(readFileSync(join(extensionPath, "background.mjs"), "utf8")).not.toMatch(/bringToFront|windows\.update|tabs\.update/u);
  } finally { await context.close(); await bridge.close(); await new Promise<void>(done => server.close(() => done())); rmSync(directory, { recursive: true, force: true }); }
}, 30_000);
