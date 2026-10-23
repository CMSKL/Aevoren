/* global crypto, URL, setTimeout, clearTimeout */
const error = code => Object.assign(new Error(code), { code });
const changed = () => error("HOST_BROWSER_TARGET_CHANGED");
export function allowedUrl(value) { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }

/** A fresh implementation of fixed tab-scoped commands; callers cannot supply CDP method names. */
export function createTabController(api, onShared) {
  const tabs = new Map();
  const publish = () => onShared([...tabs.values()].map(({ tabId, documentId, title, url, ready }) => ({ tabId, documentId, title, url, ready })));
  const requireTab = (tabId, documentId, signal) => {
    signal?.throwIfAborted(); const tab = tabs.get(tabId);
    if (!tab || !tab.ready || documentId !== undefined && tab.documentId !== documentId) throw changed();
    return tab;
  };
  async function release(tab) {
    if (tab.releasing) return tab.releasing;
    if (tab.releaseFailed) throw Object.assign(error("HOST_BROWSER_UNAVAILABLE"), { cleanupFailed: true });
    const held = tab.held; tab.held = undefined;
    if (held) {
      tab.releasing = api.debugger.sendCommand({ tabId: tab.tabId }, held.method, held.params).catch(() => { tab.releaseFailed = true; throw Object.assign(error("HOST_BROWSER_UNAVAILABLE"), { cleanupFailed: true }); }).finally(() => { tab.releasing = undefined; });
      await tab.releasing;
    }
  }
  async function unshare(tabId) {
    const tab = tabs.get(tabId); if (!tab) return;
    tabs.delete(tabId); tab.notify?.(); publish();
    let releaseFailure; try { await release(tab); } catch (failure) { releaseFailure = failure; }
    try { await api.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: false }); } catch { /* Detached or closed. */ }
    try { await api.debugger.detach({ tabId }); } catch { /* Detached or closed. */ }
    if (releaseFailure) throw releaseFailure;
  }
  async function share(tabId) {
    if (!Number.isInteger(tabId) || tabs.size >= 20) throw error("INVALID_REQUEST");
    const info = await api.tabs.get(tabId); if (!allowedUrl(info.url)) throw error("INVALID_REQUEST");
    await unshare(tabId);
    const tab = { tabId, title: String(info.title ?? "").slice(0, 512), url: info.url, documentId: crypto.randomUUID(), ready: false, frameId: "", notify: undefined };
    tabs.set(tabId, tab);
    try {
      await api.debugger.attach({ tabId }, "1.3");
      await api.debugger.sendCommand({ tabId }, "Page.enable", {});
      await api.debugger.sendCommand({ tabId }, "DOM.enable", {});
      await api.debugger.sendCommand({ tabId }, "Page.setInterceptFileChooserDialog", { enabled: true });
      const { frameTree } = await api.debugger.sendCommand({ tabId }, "Page.getFrameTree", {});
      if (tabs.get(tabId) !== tab || !allowedUrl(frameTree.frame.url)) throw changed();
      tab.frameId = frameTree.frame.id; tab.url = frameTree.frame.url; tab.ready = true; publish();
    } catch (failure) { await unshare(tabId); throw failure; }
  }
  const event = (source, method, params) => {
    const tab = tabs.get(source.tabId); if (!tab || source.sessionId) return;
    if (method === "Page.javascriptDialogOpening" || method === "Page.fileChooserOpened" || method === "Inspector.targetCrashed") { void unshare(tab.tabId).catch(() => {}); return; }
    if (method === "Page.frameStartedLoading" && params.frameId === tab.frameId) { tab.ready = false; tab.documentId = crypto.randomUUID(); publish(); }
    if (method === "Page.frameNavigated" && !params.frame.parentId || method === "Page.navigatedWithinDocument" && params.frameId === tab.frameId) {
      const frame = params.frame ?? params;
      if (!allowedUrl(frame.url)) { void unshare(tab.tabId).catch(() => {}); return; }
      tab.frameId = frame.id ?? tab.frameId; tab.url = frame.url; tab.documentId = crypto.randomUUID(); tab.ready = true; publish(); tab.notify?.();
    }
  };
  const detached = source => { void unshare(source.tabId).catch(() => {}); }, removed = tabId => { void unshare(tabId).catch(() => {}); };
  api.debugger.onEvent.addListener(event); api.debugger.onDetach.addListener(detached); api.tabs.onRemoved.addListener(removed);
  async function handle(request, signal) {
    if (!Number.isFinite(request.deadline) || Date.now() > request.deadline) throw error("HOST_BROWSER_UNAVAILABLE");
    const tab = requireTab(request.tabId, request.documentId, signal), args = request.arguments ?? {};
    const documentId = tab.documentId;
    const command = async (method, params = {}) => {
      requireTab(tab.tabId, documentId, signal);
      if (Date.now() > request.deadline) throw error("HOST_BROWSER_UNAVAILABLE");
      const value = await api.debugger.sendCommand({ tabId: tab.tabId }, method, params);
      requireTab(tab.tabId, documentId, signal); return value;
    };
    const viewport = async () => {
      const value = await command("Page.getLayoutMetrics"); const rect = value.cssVisualViewport ?? value.cssLayoutViewport;
      if (!rect || !(rect.clientWidth > 0 && rect.clientHeight > 0)) throw changed();
      return rect;
    };
    if (request.operation === "capture") {
      const rect = await viewport(), scale = Math.min(1, 1600 / Math.max(rect.clientWidth, rect.clientHeight));
      const { data } = await command("Page.captureScreenshot", { format: "jpeg", quality: 75, fromSurface: true, captureBeyondViewport: false, clip: { x: rect.pageX, y: rect.pageY, width: rect.clientWidth, height: rect.clientHeight, scale } });
      return { documentId, data: { dataBase64: data, width: Math.round(rect.clientWidth * scale), height: Math.round(rect.clientHeight * scale), viewportWidth: rect.clientWidth, viewportHeight: rect.clientHeight } };
    }
    if (request.operation === "read") {
      const { root } = await command("DOM.getDocument", { depth: -1, pierce: false });
      const text = [], elements = []; let visited = 0, textLength = 0;
      const visit = node => {
        if (++visited > 10000 || ["SCRIPT", "STYLE", "NOSCRIPT"].includes(node.nodeName)) return;
        const attributes = Object.fromEntries(Array.from({ length: Math.floor((node.attributes?.length ?? 0) / 2) }, (_, index) => [node.attributes[index * 2], node.attributes[index * 2 + 1]]));
        if (attributes.type === "password" || "hidden" in attributes || attributes["aria-hidden"] === "true") return;
        if (node.nodeType === 3 && textLength < 32000) { const value = String(node.nodeValue).slice(0, 32000 - textLength); text.push(value); textLength += value.length; }
        if (elements.length < 200 && ["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(node.nodeName)) elements.push({ nodeId: node.nodeId, tag: node.nodeName.toLowerCase(), name: String(attributes["aria-label"] ?? attributes.placeholder ?? "").slice(0, 200), type: attributes.type ?? "" });
        for (const child of node.children ?? []) visit(child);
      };
      visit(root); return { documentId, data: { url: tab.url, text: text.join(" "), elements, truncated: visited > 10000 || textLength >= 32000 } };
    }
    if (request.operation === "navigate") {
      if (!allowedUrl(args.url)) throw error("INVALID_REQUEST");
      let timer, abort;
      const navigation = new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); tab.notify = undefined; };
        tab.notify = () => { if (tabs.get(tab.tabId) !== tab) { cleanup(); reject(changed()); } else if (tab.ready && tab.documentId !== documentId) { cleanup(); resolve(); } };
        abort = () => { cleanup(); reject(signal.reason); };
        timer = setTimeout(() => { cleanup(); reject(error("HOST_BROWSER_UNAVAILABLE")); }, Math.max(1, Math.min(15000, request.deadline - Date.now())));
        signal?.addEventListener("abort", abort, { once: true });
      });
      void navigation.catch(() => {});
      // Install the navigation observer before dispatch. No replay if delivery is uncertain.
      const result = await api.debugger.sendCommand({ tabId: tab.tabId }, "Page.navigate", { url: args.url }).catch(async failure => { await unshare(tab.tabId); await navigation.catch(() => {}); throw failure; });
      if (result.errorText) { await unshare(tab.tabId); await navigation.catch(() => {}); throw error("HOST_BROWSER_UNAVAILABLE"); }
      await navigation; requireTab(tab.tabId, undefined, signal);
      return { documentId: tab.documentId, data: { url: tab.url } };
    }
    if (request.operation !== "input") throw error("INVALID_REQUEST");
    const rect = await viewport();
    const point = value => { if (!Number.isFinite(value.x) || !Number.isFinite(value.y) || value.x < 0 || value.y < 0 || value.x >= rect.clientWidth || value.y >= rect.clientHeight) throw error("INVALID_REQUEST"); return { x: value.x, y: value.y }; };
    const mouse = (type, value, extra = {}) => command("Input.dispatchMouseEvent", { type, ...point(value), ...extra });
    if (!["click", "move", "drag", "scroll", "type", "key"].includes(args.operation)) throw error("INVALID_REQUEST");
    await command("Emulation.setFocusEmulationEnabled", { enabled: true });
    try {
      if (args.operation === "click") {
        const position = point(args), found = await command("DOM.getNodeForLocation", { x: Math.floor(position.x), y: Math.floor(position.y), includeUserAgentShadowDOM: false });
        const { node } = await command("DOM.describeNode", { backendNodeId: found.backendNodeId });
        const { root } = await command("DOM.getDocument", { depth: -1, pierce: true });
        let visited = 0;
        const pathToHit = current => {
          if (!current || ++visited > 10000) return [];
          if (current.backendNodeId === found.backendNodeId) return [current];
          for (const child of [...current.children ?? [], ...current.shadowRoots ?? []]) { const path = pathToHit(child); if (path.length) return [current, ...path]; }
          return [];
        };
        const ancestors = pathToHit(root); if (!ancestors.length) ancestors.push(node);
        for (const current of ancestors) {
          const attrs = current.attributes ?? [];
          if (current.nodeName === "INPUT" && attrs.some((value, index) => value === "type" && attrs[index + 1] === "file") || attrs.some((value, index) => value === "href" && !allowedUrl(new URL(attrs[index + 1], tab.url).href))) throw error("INVALID_REQUEST");
        }
        const button = args.button ?? "left", count = args.count ?? 1;
        if (!["left", "right"].includes(button) || ![1, 2].includes(count)) throw error("INVALID_REQUEST");
        for (let clickCount = 1; clickCount <= count; clickCount++) {
          tab.held = { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", ...position, button, clickCount } };
          await mouse("mousePressed", args, { button, clickCount }); await mouse("mouseReleased", args, { button, clickCount }); tab.held = undefined;
        }
      } else if (args.operation === "move") await mouse("mouseMoved", args);
      else if (args.operation === "scroll") {
        if (![args.deltaX ?? 0, args.deltaY].every(value => Number.isFinite(value) && Math.abs(value) <= 10000)) throw error("INVALID_REQUEST");
        await mouse("mouseWheel", args, { deltaX: args.deltaX ?? 0, deltaY: args.deltaY });
      } else if (args.operation === "type") {
        if (typeof args.text !== "string" || args.text.length > 32000) throw error("INVALID_REQUEST"); await command("Input.insertText", { text: args.text });
      } else if (args.operation === "drag") {
        if (!Array.isArray(args.path) || args.path.length < 2 || args.path.length > 128 || !["left", "right"].includes(args.button)) throw error("INVALID_REQUEST");
        args.path.forEach(point); tab.held = { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", ...args.path[0], button: args.button, clickCount: 1 } };
        await mouse("mousePressed", args.path[0], { button: args.button, clickCount: 1 });
        for (const position of args.path.slice(1)) { tab.held.params = { ...tab.held.params, ...position }; await mouse("mouseMoved", position, { button: args.button, buttons: args.button === "left" ? 1 : 2 }); }
        await mouse("mouseReleased", args.path.at(-1), { button: args.button, clickCount: 1 }); tab.held = undefined;
      } else {
        const keys = { Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
        const value = String(args.key), match = /^(?:(Shift)\+)?(Enter|Tab|Backspace|Delete|Escape|ArrowLeft|ArrowUp|ArrowRight|ArrowDown|Home|End|PageUp|PageDown)$/.exec(value), select = /^(Control|Meta)\+[Aa]$/.exec(value);
        if (!match && !select) throw error("INVALID_REQUEST");
        const key = select ? "a" : match[2], code = select ? "KeyA" : key, modifiers = select ? select[1] === "Meta" ? 4 : 2 : match[1] ? 8 : 0;
        const keyArgs = { key, code, modifiers, windowsVirtualKeyCode: select ? 65 : keys[key] };
        tab.held = { method: "Input.dispatchKeyEvent", params: { type: "keyUp", ...keyArgs } };
        for (const type of ["rawKeyDown", "keyUp"]) await command("Input.dispatchKeyEvent", { type, ...keyArgs }); tab.held = undefined;
      }
      return { documentId, data: { executed: true } };
    } finally { await release(tab); if (tabs.get(tab.tabId) === tab) try { await api.debugger.sendCommand({ tabId: tab.tabId }, "Emulation.setFocusEmulationEnabled", { enabled: false }); } catch { /* Target may have detached. */ } }
  }
  return { share, unshare, handle, list: () => [...tabs.values()].map(({ tabId, title, url, ready }) => ({ tabId, title, url, ready })), clear: async () => { await Promise.all([...tabs.keys()].map(unshare)); } };
}
