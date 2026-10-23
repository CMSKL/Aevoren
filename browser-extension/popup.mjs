/* global chrome, document */
const $ = id => document.getElementById(id);
async function act(message) {
  $("error").textContent = "";
  try {
    const result = await chrome.runtime.sendMessage(message); if (!result.ok) throw new Error(result.message);
    $("status").textContent = result.connected ? "已连接" : "尚未连接"; $("share").disabled = !result.connected;
    $("targets").replaceChildren(...result.targets.map(target => {
      const row = document.createElement("li"), title = document.createElement("span"), button = document.createElement("button");
      title.textContent = target.title || target.url; button.textContent = "停止共享"; button.onclick = () => void act({ type: "unshare", tabId: target.tabId }); row.append(title, button); return row;
    }));
  } catch (failure) { $("error").textContent = failure.message; }
}
$("pair").onsubmit = event => { event.preventDefault(); void act({ type: "pair", endpoint: $("endpoint").value.trim(), code: $("code").value.trim() }); };
$("reconnect").onclick = () => void act({ type: "reconnect" }); $("forget").onclick = () => void act({ type: "forget" });
$("share").onclick = async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (tab?.id !== undefined) await act({ type: "share", tabId: tab.id }); };
void act({ type: "status" });
