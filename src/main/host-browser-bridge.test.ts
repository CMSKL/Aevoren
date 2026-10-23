import { once } from "node:events";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostBrowserBridge, HOST_BROWSER_EXTENSION_ID, type HostBrowserConfiguration } from "./host-browser-bridge";

const origin = `chrome-extension://${HOST_BROWSER_EXTENSION_ID}`;
const jpeg = readFileSync(new URL("../../tests/fixtures/media-parser/red.jpg", import.meta.url));
const owned: HostBrowserBridge[] = [], clients: WebSocket[] = [];
function bridge(options = {}): HostBrowserBridge {
  let value: HostBrowserConfiguration | null = null;
  const result = new HostBrowserBridge({ read: () => value, write: next => { value = next; } }, options);
  owned.push(result); return result;
}
async function connect(endpoint: string, request: object, clientOrigin = origin): Promise<{ socket: WebSocket; reply: Record<string, unknown> }> {
  const socket = new WebSocket(endpoint, { origin: clientOrigin }); clients.push(socket);
  await once(socket, "open"); const received = once(socket, "message"); socket.send(JSON.stringify(request));
  return { socket, reply: JSON.parse((await received)[0].toString()) };
}
async function paired(gateway: HostBrowserBridge, acknowledgeRelease = true) {
  const pairing = await gateway.pair(), result = await connect(pairing.endpoint, { type: "pair", code: pairing.code });
  const target = { kind: "browser" as const, connectionId: result.reply.connectionId as string, tabId: 7, title: "Owned fixture", url: "https://example.test/owned" };
  result.socket.on("message", bytes => { const message = JSON.parse(bytes.toString()); if (message.type === "release" && acknowledgeRelease) result.socket.send(JSON.stringify({ type: "released", id: message.id, confirmed: true })); });
  result.socket.send(JSON.stringify({ type: "shared", targets: [{ ...target, documentId: "document-a" }] }));
  await vi.waitFor(async () => expect(await gateway.listTargets(AbortSignal.timeout(1000))).toEqual([target]));
  return { ...result, pairing, target };
}
afterEach(async () => { clients.splice(0).forEach(client => client.terminate()); await Promise.all(owned.splice(0).map(item => item.close())); });

describe("paired tab-only loopback browser bridge", () => {
  it("does not revive an older pairing after revoke while configuration is loading", async () => {
    let loaded!: (value: null) => void;
    const gateway = new HostBrowserBridge({ read: () => new Promise<null>(resolve => { loaded = resolve; }), write: () => {} }); owned.push(gateway);
    const pairing = gateway.pair().then(value => ({ value }), error => ({ error }));
    await gateway.revoke(); loaded(null);
    expect(await pairing).toMatchObject({ error: { code: "HOST_BROWSER_PAIRING_INVALID" } });
  });

  it("does not revive an older pairing after revoke while persistence is pending", async () => {
    let saved!: () => void, writes = 0;
    const gateway = new HostBrowserBridge({ read: () => null, write: () => ++writes === 1 ? new Promise<void>(resolve => { saved = resolve; }) : undefined }); owned.push(gateway);
    const pairing = gateway.pair().then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(saved).toBeTypeOf("function")); const revoked = gateway.revoke(); saved();
    await revoked; expect(await pairing).toMatchObject({ error: { code: "HOST_BROWSER_PAIRING_INVALID" } });
  });

  it("does not publish an older pairing after revoke during listener startup", async () => {
    const gateway = bridge(), internal = gateway as unknown as { listen(port?: number): Promise<void> }, listen = internal.listen.bind(gateway);
    let listening!: () => void, entered = false;
    internal.listen = async port => { await listen(port); entered = true; await new Promise<void>(resolve => { listening = resolve; }); };
    const pairing = gateway.pair().then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => expect(entered).toBe(true)); await gateway.revoke(); listening();
    expect(await pairing).toMatchObject({ error: { code: "HOST_BROWSER_PAIRING_INVALID" } });
  });

  it("shares pending release cleanup and lets the later revoke cancel an older pairing", async () => {
    const gateway = bridge(), { socket } = await paired(gateway, false); let releaseId = "", releaseCount = 0;
    socket.on("message", bytes => { const message = JSON.parse(bytes.toString()); if (message.type === "release") { releaseId = message.id; releaseCount++; } });
    const pairing = gateway.pair().then(value => ({ value }), error => ({ error })), revoked = gateway.revoke();
    await vi.waitFor(() => expect(releaseId).not.toBe(""));
    socket.send(JSON.stringify({ type: "released", id: releaseId, confirmed: true }));
    await revoked; expect(await pairing).toMatchObject({ error: { code: "HOST_BROWSER_PAIRING_INVALID" } }); expect(releaseCount).toBe(1);
  });

  it("rejects foreign origins and consumes a short-lived pairing code only once", async () => {
    let now = 1000; const gateway = bridge({ now: () => now }), pairing = await gateway.pair();
    const denied = new WebSocket(pairing.endpoint, { origin: "https://attacker.test" }); clients.push(denied);
    await expect(once(denied, "open")).rejects.toThrow(); expect(gateway.status()).toEqual({ connected: false });
    now += 120_001;
    expect((await connect(pairing.endpoint, { type: "pair", code: pairing.code })).reply).toMatchObject({ type: "error", code: "HOST_BROWSER_PAIRING_INVALID" });
    const fresh = await gateway.pair(), first = await connect(fresh.endpoint, { type: "pair", code: fresh.code });
    expect(first.reply).toMatchObject({ type: "authenticated" }); expect(first.reply.token).toEqual(expect.any(String));
    expect((await connect(fresh.endpoint, { type: "pair", code: fresh.code })).reply).toMatchObject({ type: "error", code: "HOST_BROWSER_PAIRING_INVALID" });
  });

  it("binds captures and actions to a shared tab document and rejects stale observations on navigation", async () => {
    const gateway = bridge(), { socket, target } = await paired(gateway); const requests: Record<string, unknown>[] = [];
    socket.on("message", bytes => {
      const message = JSON.parse(bytes.toString()); requests.push(message);
      if (message.operation === "capture") socket.send(JSON.stringify({ type: "result", id: message.id, documentId: "document-a", data: { dataBase64: jpeg.toString("base64"), width: 4, height: 4, viewportWidth: 800, viewportHeight: 600 } }));
    });
    const capture = await gateway.capture(target, AbortSignal.timeout(1000));
    expect(capture.context).toMatchObject({ kind: "browser", target, documentId: "document-a" });
    const input = gateway.input("click", { x: 30, y: 40, button: "left" }, capture.context, AbortSignal.timeout(1000));
    const failure = expect(input).rejects.toMatchObject({ code: "HOST_BROWSER_TARGET_CHANGED" });
    await vi.waitFor(() => expect(requests.some(request => request.operation === "input")).toBe(true));
    socket.send(JSON.stringify({ type: "shared", targets: [] })); await failure;
    await expect(gateway.input("click", { x: 30, y: 40 }, capture.context, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: "HOST_BROWSER_TARGET_CHANGED" });
    expect(requests.filter(request => request.operation === "input")).toHaveLength(1);
  });

  it("does not replay an unknown action after timeout or reconnect and rotates connection identity", async () => {
    const gateway = bridge({ requestTimeoutMs: 30 }), { socket, target, reply, pairing } = await paired(gateway); let sent = 0;
    socket.on("message", bytes => { const message = JSON.parse(bytes.toString()); if (message.type === "request") sent++; else if (message.type === "cancel") socket.send(JSON.stringify({ type: "cancelled", id: message.id, confirmed: true })); });
    const context = { kind: "browser" as const, target, documentId: "document-a", x: 0, y: 0, width: 800, height: 600 };
    await expect(gateway.input("click", { x: 5, y: 5 }, context, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: "HOST_BROWSER_UNAVAILABLE" });
    expect(sent).toBe(1); socket.close(); await once(socket, "close");
    const next = await connect(pairing.endpoint, { type: "authenticate", token: reply.token });
    expect(next.reply.connectionId).not.toBe(target.connectionId);
    await expect(gateway.capture(target, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: "HOST_BROWSER_TARGET_CHANGED" });
    expect(sent).toBe(1);
  });

  it("allows only fixed commands and http(s) navigation and clears stored authentication on revoke", async () => {
    const gateway = bridge(), { socket, target, reply, pairing } = await paired(gateway); let sent = 0;
    socket.on("message", () => { sent++; });
    const context = { kind: "browser" as const, target, documentId: "document-a", x: 0, y: 0, width: 800, height: 600 };
    await expect(gateway.input("Runtime.evaluate", { expression: "alert(1)" }, context, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(gateway.input("type", { text: "replacement", replace: true }, context, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    for (const url of ["javascript:alert(1)", "file:///tmp/test", "chrome://settings", "https://user:secret@example.test/"]) await expect(gateway.navigate(target, url, context, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(sent).toBe(0); await gateway.revoke(); expect(gateway.status()).toEqual({ connected: false });
    expect((await connect(pairing.endpoint, { type: "authenticate", token: reply.token })).reply).toMatchObject({ type: "error", code: "HOST_BROWSER_PAIRING_INVALID" });
  });

  it("retains the shared tab across explicit navigation while revoking the old document", async () => {
    const gateway = bridge(), { socket, target } = await paired(gateway);
    const context = { kind: "browser" as const, target, documentId: "document-a", x: 0, y: 0, width: 800, height: 600 };
    socket.on("message", bytes => {
      const request = JSON.parse(bytes.toString()); if (request.operation !== "navigate") return;
      socket.send(JSON.stringify({ type: "shared", targets: [{ ...target, url: "https://next.test/", documentId: "document-b", ready: false }] }));
      socket.send(JSON.stringify({ type: "shared", targets: [{ ...target, url: "https://next.test/", documentId: "document-b", ready: true }] }));
      socket.send(JSON.stringify({ type: "result", id: request.id, documentId: "document-b", data: { url: "https://next.test/" } }));
    });
    expect(gateway.isAuthorized(target, context)).toBe(true);
    await gateway.navigate(target, "https://next.test/", context, AbortSignal.timeout(1000));
    expect(gateway.isAuthorized(target, context)).toBe(false); expect(gateway.isAuthorized(target)).toBe(true);
    expect(await gateway.listTargets(AbortSignal.timeout(1000))).toEqual([{ ...target, url: "https://next.test/" }]);
  });

  it("waits for cancellation acknowledgement after the extension releases synthetic input", async () => {
    const gateway = bridge(), { socket, target } = await paired(gateway), abort = new AbortController();
    const context = { kind: "browser" as const, target, documentId: "document-a", x: 0, y: 0, width: 800, height: 600 };
    let requestId = "", cancellationId = "", settled = false;
    socket.on("message", bytes => { const message = JSON.parse(bytes.toString()); if (message.type === "request") requestId = message.id; if (message.type === "cancel") cancellationId = message.id; });
    const action = gateway.input("click", { x: 20, y: 20 }, context, abort.signal).finally(() => { settled = true; });
    const failure = expect(action).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(requestId).not.toBe("")); abort.abort();
    await vi.waitFor(() => expect(cancellationId).toBe(requestId)); expect(settled).toBe(false);
    socket.send(JSON.stringify({ type: "result", id: requestId, documentId: "document-a", data: { executed: true } }));
    await new Promise<void>(done => setImmediate(done)); expect(settled).toBe(false);
    socket.send(JSON.stringify({ type: "cancelled", id: requestId, confirmed: true })); await failure;
  });

  it("rejects invalid JPEG dimensions and incomplete pixels and hides navigating targets", async () => {
    const gateway = bridge(), { socket, target } = await paired(gateway); let validDimensions = false;
    socket.on("message", bytes => { const request = JSON.parse(bytes.toString()); if (request.operation === "capture") socket.send(JSON.stringify({ type: "result", id: request.id, documentId: "document-a", data: { dataBase64: (validDimensions ? jpeg.subarray(0, -2) : jpeg).toString("base64"), width: validDimensions ? 4 : 800, height: 4, viewportWidth: 800, viewportHeight: 600 } })); });
    await expect(gateway.capture(target, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: "BROWSER_MEDIA_INVALID" }); validDimensions = true;
    await expect(gateway.capture(target, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: "BROWSER_MEDIA_INVALID" });
    socket.send(JSON.stringify({ type: "shared", targets: [{ ...target, documentId: "document-b", ready: false }] }));
    await vi.waitFor(async () => expect(await gateway.listTargets(AbortSignal.timeout(1000))).toEqual([])); expect(gateway.isAuthorized(target)).toBe(false);
  });

  it("disconnects and reports an unknown stop when the extension cannot confirm cleanup", async () => {
    const gateway = bridge(), { socket, target } = await paired(gateway), abort = new AbortController();
    const context = { kind: "browser" as const, target, documentId: "document-a", x: 0, y: 0, width: 800, height: 600 };
    socket.on("message", bytes => { const message = JSON.parse(bytes.toString()); if (message.type === "request") abort.abort(); if (message.type === "cancel") socket.send(JSON.stringify({ type: "cancelled", id: message.id, confirmed: false })); });
    await expect(gateway.input("click", { x: 20, y: 20 }, context, abort.signal)).rejects.toMatchObject({ code: "HOST_COMPUTER_STOP_UNKNOWN" });
    expect(gateway.status()).toEqual({ connected: false }); expect(gateway.isAuthorized(target, context)).toBe(false);
  });

  it("synchronously revokes authorization while awaiting cleanup and rejects a negative release acknowledgement", async () => {
    const gateway = bridge(), { socket, target } = await paired(gateway, false); let releaseId = "";
    socket.on("message", bytes => { const message = JSON.parse(bytes.toString()); if (message.type === "release") releaseId = message.id; });
    const revoked = gateway.revoke(), failure = expect(revoked).rejects.toMatchObject({ code: "HOST_COMPUTER_STOP_UNKNOWN" });
    expect(gateway.status().connected).toBe(false); expect(gateway.isAuthorized(target)).toBe(false);
    await vi.waitFor(() => expect(releaseId).not.toBe(""));
    socket.send(JSON.stringify({ type: "shared", targets: [{ ...target, documentId: "document-a" }] }));
    await new Promise<void>(done => setImmediate(done));
    expect(await gateway.listTargets(AbortSignal.timeout(1000))).toEqual([]); expect(gateway.isAuthorized(target)).toBe(false);
    socket.send(JSON.stringify({ type: "released", id: releaseId, confirmed: false })); await failure;
    expect(gateway.status().connected).toBe(false);
  });

  it.each(["disconnect", "timeout"])("keeps cancellation cleanup %s distinguishable from a confirmed stop", async mode => {
    const gateway = bridge(), { socket, target } = await paired(gateway), abort = new AbortController();
    const context = { kind: "browser" as const, target, documentId: "document-a", x: 0, y: 0, width: 800, height: 600 };
    socket.on("message", bytes => { const message = JSON.parse(bytes.toString()); if (message.type === "request") abort.abort(); if (message.type === "cancel" && mode === "disconnect") socket.close(); });
    await expect(gateway.input("click", { x: 20, y: 20 }, context, abort.signal)).rejects.toMatchObject({ code: "HOST_COMPUTER_STOP_UNKNOWN" });
    expect(gateway.status().connected).toBe(false);
  });

  it.each(["disconnect", "timeout"])("keeps session release %s distinguishable from a confirmed revoke", async mode => {
    const gateway = bridge(), { socket } = await paired(gateway, false);
    socket.on("message", bytes => { const message = JSON.parse(bytes.toString()); if (message.type === "release" && mode === "disconnect") socket.close(); });
    await expect(gateway.revoke()).rejects.toMatchObject({ code: "HOST_COMPUTER_STOP_UNKNOWN" });
    expect(gateway.status().connected).toBe(false);
  });
});
