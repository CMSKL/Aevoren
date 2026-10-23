/* global chrome, WebSocket, AbortController, setInterval, clearInterval */
import { createTabController } from "./commands.mjs";

let socket, connectionId, queue = Promise.resolve(), heartbeat;
const requests = new Map();
const completed = new Map();
const send = message => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); };
const tabs = createTabController(chrome, targets => { if (connectionId) send({ type: "shared", targets }); });
async function disconnect() {
  connectionId = undefined; clearInterval(heartbeat); for (const controller of requests.values()) controller.abort(); requests.clear();
  const previous = socket; socket = undefined; previous?.close(); completed.clear(); await tabs.clear().catch(() => {});
}
async function connect(endpoint, authentication) {
  if (!/^ws:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/host-browser$/.test(endpoint) || Number(endpoint.split(":")[2].split("/")[0]) > 65535) throw new Error("本机地址无效");
  await disconnect();
  const client = new WebSocket(endpoint); socket = client;
  return new Promise((resolve, reject) => {
    client.onopen = () => client.send(JSON.stringify(authentication));
    client.onerror = () => reject(new Error("无法连接 Aevoren，请检查配对地址"));
    client.onclose = () => { if (socket === client) void disconnect(); reject(new Error("连接已断开，请重新连接并共享标签页")); };
    client.onmessage = event => {
      if (socket !== client) return;
      let message; try { message = JSON.parse(event.data); } catch { void disconnect(); return; }
      if (message.type === "authenticated") {
        connectionId = message.connectionId;
        void chrome.storage.local.set({ pairing: { endpoint, token: message.token ?? authentication.token } });
        heartbeat = setInterval(() => send({ type: "ping" }), 20_000); resolve(); return;
      }
      if (message.type === "error") { reject(new Error("配对码已失效，请在 Aevoren 中重新生成")); void disconnect(); return; }
      if (message.type === "cancel") { const pending = requests.get(message.id); if (pending) pending.abort(); else send({ type: "cancelled", id: message.id, confirmed: completed.get(message.id) === true }); return; }
      if (message.type === "release") {
        for (const controller of requests.values()) controller.abort();
        void queue.catch(() => {}).then(() => tabs.clear()).then(() => { if (socket === client) send({ type: "released", id: message.id, confirmed: true }); }).catch(() => { if (socket === client) send({ type: "released", id: message.id, confirmed: false }); });
        return;
      }
      if (message.type !== "request" || !connectionId) return;
      const controller = new AbortController(); requests.set(message.id, controller);
      queue = queue.catch(() => {}).then(async () => {
        let cleanupConfirmed = true;
        try { const result = await tabs.handle(message, controller.signal); if (socket === client && !controller.signal.aborted) send({ type: "result", id: message.id, ...result }); }
        catch (failure) { cleanupConfirmed = !failure.cleanupFailed; if (socket === client && !controller.signal.aborted) send({ type: "result", id: message.id, documentId: message.documentId, error: ["HOST_BROWSER_TARGET_CHANGED", "INVALID_REQUEST"].includes(failure.code) ? failure.code : "HOST_BROWSER_UNAVAILABLE" }); }
        finally { requests.delete(message.id); if (socket === client) { completed.set(message.id, cleanupConfirmed); if (completed.size > 100) completed.delete(completed.keys().next().value); if (controller.signal.aborted) send({ type: "cancelled", id: message.id, confirmed: cleanupConfirmed }); } }
      });
    };
  });
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) return false;
  void (async () => {
    if (message.type === "pair") await connect(message.endpoint, { type: "pair", code: message.code });
    else if (message.type === "reconnect") { const { pairing } = await chrome.storage.local.get("pairing"); if (!pairing) throw new Error("请先配对"); await connect(pairing.endpoint, { type: "authenticate", token: pairing.token }); }
    else if (message.type === "share") { if (!connectionId) throw new Error("请先连接 Aevoren"); await tabs.share(message.tabId); }
    else if (message.type === "unshare") await tabs.unshare(message.tabId);
    else if (message.type === "forget") { await disconnect(); await chrome.storage.local.remove("pairing"); }
    else if (message.type !== "status") throw new Error("不支持的操作");
    reply({ ok: true, connected: Boolean(connectionId), targets: tabs.list() });
  })().catch(failure => reply({ ok: false, message: failure.message }));
  return true;
});
