import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import type { HostBrowserContext, HostBrowserPairing, HostBrowserTarget, HostCapture, HostInputContext } from "@shared/host-computer-targets";
import { AevorenBotError } from "./errors";
import { imageDimensions } from "../browser-worker/image";

export const HOST_BROWSER_EXTENSION_ID = "bbmpoldldilakpkipdjkgpjhhkhbglin";
export type HostBrowserConfiguration = { port: number; token: string };
export type HostBrowserStore = {
  read(): HostBrowserConfiguration | null | Promise<HostBrowserConfiguration | null>;
  write(value: HostBrowserConfiguration | null): void | Promise<void>;
};
const configurationSchema = z.object({ port: z.number().int().min(1).max(65535), token: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const tabSchema = z.object({ tabId: z.number().int().nonnegative(), documentId: z.string().min(1).max(200), title: z.string().max(512), url: z.string().max(4000), ready: z.boolean().default(true) });
const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("shared"), targets: z.array(tabSchema).max(20) }),
  z.object({ type: z.literal("result"), id: z.string(), documentId: z.string(), data: z.unknown().optional(), error: z.enum(["HOST_BROWSER_UNAVAILABLE", "HOST_BROWSER_TARGET_CHANGED", "INVALID_REQUEST"]).optional() }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("cancelled"), id: z.string(), confirmed: z.boolean() }),
  z.object({ type: z.literal("released"), id: z.string(), confirmed: z.boolean() }),
]);
const captureSchema = z.object({ dataBase64: z.string().max(2_800_000).regex(/^[A-Za-z0-9+/]+={0,2}$/u), width: z.number().int().positive().max(1600), height: z.number().int().positive().max(1600), viewportWidth: z.number().positive().max(20000), viewportHeight: z.number().positive().max(20000) });
const pointSchema = z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() });
type Pending = { tabId: number; documentId: string; navigating: boolean; reject(error: Error): void; resolve(value: unknown): void; cancelled(confirmed: boolean): void; disconnected(): void };
type Connection = { socket: WebSocket; id: string; tabs: Map<number, z.infer<typeof tabSchema>>; revoking?: boolean; release?: Promise<void> };
function sameSecret(left: string, right: string): boolean { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function validUrl(value: string): boolean { try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; } }

/** Only an explicitly paired extension can expose its user-shared tabs. No CDP endpoint is exported. */
export class HostBrowserBridge {
  private server?: Server;
  private sockets?: WebSocketServer;
  private listening?: Promise<void>;
  private configuration: HostBrowserConfiguration | null = null;
  private pairing?: { code: string; expiresAt: number };
  private connection?: Connection;
  private pending = new Map<string, Pending>();
  private releases = new Map<string, (confirmed: boolean) => void>();
  private generation = 0;
  private closed = false;
  private writes: Promise<void> = Promise.resolve();
  private ready: Promise<void>;
  private now: () => number;
  private requestTimeoutMs: number;
  constructor(private readonly store: HostBrowserStore, options: { now?: () => number; requestTimeoutMs?: number } = {}) {
    this.now = options.now ?? Date.now; this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.ready = this.restore().catch(() => { this.configuration = null; });
  }
  private async restore(): Promise<void> {
    const generation = this.generation;
    const parsed = configurationSchema.safeParse(await this.store.read());
    if (parsed.success && !this.closed && generation === this.generation) { await this.listen(parsed.data.port); if (!this.closed && generation === this.generation) this.configuration = parsed.data; }
  }
  status(): { connected: boolean } { return { connected: !this.connection?.revoking && this.connection?.socket.readyState === WebSocket.OPEN }; }
  private persist(value: HostBrowserConfiguration | null): Promise<void> {
    const write = this.writes.catch(() => {}).then(() => this.store.write(value)); this.writes = write; return write;
  }
  private async listen(port = 0): Promise<void> {
    if (this.listening) return this.listening;
    if (this.server) return;
    const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 3_000_000, perMessageDeflate: false });
    server.on("upgrade", (request, socket, head) => {
      const address = server.address();
      if (this.closed || typeof address !== "object" || !address || request.url !== "/host-browser" || request.headers.host !== `127.0.0.1:${address.port}` || request.socket.remoteAddress !== "127.0.0.1" || request.headers.origin !== `chrome-extension://${HOST_BROWSER_EXTENSION_ID}`) { socket.destroy(); return; }
      sockets.handleUpgrade(request, socket, head, client => this.accept(client));
    });
    const listening = new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); }); this.listening = listening;
    try { await listening; }
    catch (error) { sockets.close(); server.close(); throw error; }
    finally { if (this.listening === listening) this.listening = undefined; }
    this.server = server; this.sockets = sockets;
  }
  private assertGeneration(generation: number): void {
    if (this.closed) throw new AevorenBotError("HOST_BROWSER_UNAVAILABLE");
    if (generation !== this.generation) throw new AevorenBotError("HOST_BROWSER_PAIRING_INVALID");
  }
  async pair(): Promise<HostBrowserPairing> {
    const generation = ++this.generation;
    await this.revokeGeneration(generation); this.assertGeneration(generation);
    await this.ready; this.assertGeneration(generation);
    await this.listen(); this.assertGeneration(generation);
    const address = this.server!.address(); if (!address || typeof address === "string") throw new AevorenBotError("HOST_BROWSER_UNAVAILABLE");
    this.pairing = { code: randomBytes(12).toString("hex"), expiresAt: this.now() + 120_000 };
    return { endpoint: `ws://127.0.0.1:${address.port}/host-browser`, code: this.pairing.code, expiresAt: new Date(this.pairing.expiresAt).toISOString() };
  }
  async revoke(): Promise<void> {
    return this.revokeGeneration(++this.generation);
  }
  private async revokeGeneration(generation: number): Promise<void> {
    this.pairing = undefined; this.configuration = null;
    const connection = this.connection; if (connection) { connection.revoking = true; connection.tabs.clear(); }
    let failure: unknown;
    if (connection?.socket.readyState === WebSocket.OPEN) try {
      connection.release ??= new Promise<void>((resolve, reject) => {
        const id = randomUUID(), timer = setTimeout(() => { this.releases.delete(id); reject(new AevorenBotError("HOST_COMPUTER_STOP_UNKNOWN")); }, 2000); timer.unref();
        this.releases.set(id, confirmed => { clearTimeout(timer); this.releases.delete(id); if (confirmed) resolve(); else reject(new AevorenBotError("HOST_COMPUTER_STOP_UNKNOWN")); });
        connection.socket.send(JSON.stringify({ type: "release", id }));
      }).finally(() => this.disconnect(connection));
      await connection.release;
    } catch (error) { failure = error; }
    else if (connection) failure = new AevorenBotError("HOST_COMPUTER_STOP_UNKNOWN");
    this.assertGeneration(generation); this.disconnect(connection); await this.persist(null); this.assertGeneration(generation); if (failure) throw failure;
  }
  private disconnect(connection = this.connection): void {
    if (!connection || this.connection !== connection) return;
    this.connection = undefined;
    for (const complete of this.releases.values()) complete(false);
    for (const request of this.pending.values()) request.disconnected();
    connection.tabs.clear(); connection.socket.close(1000);
  }
  private accept(socket: WebSocket): void {
    let authenticated = false, authenticating = false;
    const timeout = setTimeout(() => socket.close(1008), 10_000); timeout.unref();
    socket.on("error", () => {});
    socket.on("close", () => { clearTimeout(timeout); if (this.connection?.socket === socket) this.disconnect(this.connection); });
    socket.on("message", bytes => {
      let value: unknown; try { value = JSON.parse(bytes.toString()); } catch { socket.close(1008); return; }
      if (!authenticated) {
        if (authenticating) { socket.close(1008); return; } authenticating = true;
        void this.authenticate(socket, value).then(ok => { authenticated = ok; authenticating = false; clearTimeout(timeout); }).catch(() => { socket.close(1011); });
        return;
      }
      const connection = this.connection; if (!connection || connection.socket !== socket) { socket.close(1008); return; }
      const message = messageSchema.safeParse(value); if (!message.success) { socket.close(1008); return; }
      if (message.data.type === "ping") { socket.send(JSON.stringify({ type: "pong" })); return; }
      if (message.data.type === "cancelled") { this.pending.get(message.data.id)?.cancelled(message.data.confirmed); return; }
      if (message.data.type === "released") { this.releases.get(message.data.id)?.(message.data.confirmed); return; }
      if (message.data.type === "shared") {
        if (connection.revoking) return;
        const tabs = new Map(message.data.targets.filter(tab => validUrl(tab.url)).map(tab => [tab.tabId, tab]));
        connection.tabs = tabs;
        for (const request of this.pending.values()) if (!tabs.has(request.tabId) || !request.navigating && tabs.get(request.tabId)?.documentId !== request.documentId) request.reject(new AevorenBotError("HOST_BROWSER_TARGET_CHANGED"));
        return;
      }
      const result = message.data, request = this.pending.get(result.id); if (!request) return;
      if ((!request.navigating && result.documentId !== request.documentId) || connection.tabs.get(request.tabId)?.documentId !== result.documentId) request.reject(new AevorenBotError("HOST_BROWSER_TARGET_CHANGED"));
      else if (result.error) request.reject(new AevorenBotError(result.error));
      else request.resolve(result.data);
    });
  }
  private async authenticate(socket: WebSocket, value: unknown): Promise<boolean> {
    const parsed = z.union([z.object({ type: z.literal("pair"), code: z.string().max(100) }).strict(), z.object({ type: z.literal("authenticate"), token: z.string().max(100) }).strict()]).safeParse(value);
    const generation = this.generation; let token: string | undefined;
    if (parsed.success && parsed.data.type === "pair" && this.pairing && this.now() < this.pairing.expiresAt && sameSecret(parsed.data.code, this.pairing.code)) {
      this.pairing = undefined; token = randomBytes(32).toString("hex");
      const address = this.server!.address(); if (!address || typeof address === "string") throw new AevorenBotError("HOST_BROWSER_UNAVAILABLE");
      const configuration = { port: address.port, token }; await this.persist(configuration);
      if (generation === this.generation && !this.closed) this.configuration = configuration;
    } else if (!(parsed.success && parsed.data.type === "authenticate" && this.configuration && sameSecret(parsed.data.token, this.configuration.token))) {
      socket.send(JSON.stringify({ type: "error", code: "HOST_BROWSER_PAIRING_INVALID" })); socket.close(1008); return false;
    }
    if (generation !== this.generation || this.closed || socket.readyState !== WebSocket.OPEN) { socket.close(1008); return false; }
    this.disconnect(); this.connection = { socket, id: randomUUID(), tabs: new Map() };
    socket.send(JSON.stringify({ type: "authenticated", connectionId: this.connection.id, ...(token ? { token } : {}) })); return true;
  }
  async listTargets(signal: AbortSignal): Promise<HostBrowserTarget[]> {
    await this.ready; signal.throwIfAborted(); const connection = this.connection; if (!connection) return [];
    return [...connection.tabs.values()].filter(tab => tab.ready).map(tab => ({ kind: "browser", connectionId: connection.id, tabId: tab.tabId, title: tab.title, url: tab.url }));
  }
  private tab(target: HostBrowserTarget, documentId?: string): { connection: Connection; documentId: string } {
    const connection = this.connection, tab = connection?.tabs.get(target.tabId);
    if (!connection || connection.revoking || connection.id !== target.connectionId || !tab?.ready || documentId !== undefined && documentId !== tab.documentId) throw new AevorenBotError("HOST_BROWSER_TARGET_CHANGED");
    return { connection, documentId: tab.documentId };
  }
  isAuthorized(target: HostBrowserTarget, context?: HostInputContext): boolean {
    if (context && (context.kind !== "browser" || context.target.connectionId !== target.connectionId || context.target.tabId !== target.tabId)) return false;
    try { this.tab(target, context?.kind === "browser" ? context.documentId : undefined); return this.status().connected; } catch { return false; }
  }
  private request(target: HostBrowserTarget, operation: string, arguments_: object, signal: AbortSignal, documentId?: string): Promise<unknown> {
    signal.throwIfAborted(); const bound = this.tab(target, documentId), id = randomUUID();
    return new Promise((resolve, reject) => {
      let cancelReason: Error | undefined, cancellationTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => { clearTimeout(timer); clearTimeout(cancellationTimer); signal.removeEventListener("abort", abort); this.pending.delete(id); };
      const fail = (error: Error): void => { cleanup(); reject(error); };
      const cancel = (reason: Error): void => {
        if (cancelReason) return; cancelReason = reason; clearTimeout(timer);
        if (bound.connection.socket.readyState !== WebSocket.OPEN) { fail(new AevorenBotError("HOST_COMPUTER_STOP_UNKNOWN")); return; }
        bound.connection.socket.send(JSON.stringify({ type: "cancel", id }));
        cancellationTimer = setTimeout(() => { fail(new AevorenBotError("HOST_COMPUTER_STOP_UNKNOWN")); this.disconnect(bound.connection); }, 2000); cancellationTimer.unref();
      };
      const abort = (): void => cancel(signal.reason);
      const timer = setTimeout(() => cancel(new AevorenBotError("HOST_BROWSER_UNAVAILABLE")), this.requestTimeoutMs); timer.unref();
      this.pending.set(id, { tabId: target.tabId, documentId: bound.documentId, navigating: operation === "navigate", resolve: value => { if (!cancelReason) { cleanup(); resolve(value); } }, reject: error => { if (!cancelReason) fail(error); }, cancelled: confirmed => { if (cancelReason) { fail(confirmed ? cancelReason : new AevorenBotError("HOST_COMPUTER_STOP_UNKNOWN")); if (!confirmed) this.disconnect(bound.connection); } }, disconnected: () => fail(new AevorenBotError(cancelReason ? "HOST_COMPUTER_STOP_UNKNOWN" : "HOST_BROWSER_TARGET_CHANGED")) });
      signal.addEventListener("abort", abort, { once: true });
      bound.connection.socket.send(JSON.stringify({ type: "request", id, operation, tabId: target.tabId, documentId: bound.documentId, deadline: Date.now() + this.requestTimeoutMs, arguments: arguments_ }), error => { if (error) fail(new AevorenBotError(cancelReason ? "HOST_COMPUTER_STOP_UNKNOWN" : "HOST_BROWSER_UNAVAILABLE")); });
      if (signal.aborted) abort();
    });
  }
  async capture(target: HostBrowserTarget, signal: AbortSignal): Promise<HostCapture> {
    const { documentId } = this.tab(target), data = captureSchema.parse(await this.request(target, "capture", {}, signal, documentId));
    this.tab(target, documentId); signal.throwIfAborted(); const bytes = Buffer.from(data.dataBase64, "base64");
    try {
      const dimensions = imageDimensions(bytes, "image/jpeg");
      if (bytes.length > 2_097_152 || dimensions.width !== data.width || dimensions.height !== data.height || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Error("Invalid pixels");
    } catch { throw new AevorenBotError("BROWSER_MEDIA_INVALID"); }
    return { bytes, width: data.width, height: data.height, context: { kind: "browser", target, documentId, x: 0, y: 0, width: data.viewportWidth, height: data.viewportHeight } };
  }
  private context(context: HostInputContext): HostBrowserContext { if (context.kind !== "browser") throw new AevorenBotError("INVALID_REQUEST"); this.tab(context.target, context.documentId); return context; }
  async input(operation: string, input: Record<string, unknown>, context: HostInputContext, signal: AbortSignal): Promise<void> {
    const bound = this.context(context); let args: object;
    const point = (value: unknown): { x: number; y: number } => { const point = pointSchema.parse(value); if (point.x >= bound.width || point.y >= bound.height) throw new AevorenBotError("INVALID_REQUEST"); return point; };
    if (operation === "click" || operation === "move") args = { ...point(input), button: z.enum(["left", "right"]).default("left").parse(input.button), count: z.number().int().min(1).max(2).default(1).parse(input.count) };
    else if (operation === "scroll") args = { ...point(input), deltaX: z.number().finite().min(-10000).max(10000).default(0).parse(input.deltaX), deltaY: z.number().finite().min(-10000).max(10000).parse(input.deltaY) };
    else if (operation === "type") { if (input.replace === true) throw new AevorenBotError("INVALID_REQUEST", "后台浏览器暂不支持直接替换，请先选择文本再输入。"); args = { text: z.string().max(32000).parse(input.text) }; }
    else if (operation === "key") args = { key: z.string().min(1).max(80).parse(input.key) };
    else if (operation === "drag") args = { path: z.array(pointSchema).min(2).max(128).parse(input.path).map(point), button: z.enum(["left", "right"]).default("left").parse(input.button) };
    else throw new AevorenBotError("INVALID_REQUEST");
    await this.request(bound.target, "input", { operation, ...args }, signal, bound.documentId);
  }
  async read(target: HostBrowserTarget, signal: AbortSignal): Promise<unknown> { return this.request(target, "read", {}, signal); }
  async navigate(target: HostBrowserTarget, url: string, context: HostInputContext, signal: AbortSignal): Promise<void> {
    const bound = this.context(context);
    if (target.connectionId !== bound.target.connectionId || target.tabId !== bound.target.tabId || !validUrl(url)) throw new AevorenBotError("INVALID_REQUEST");
    await this.request(target, "navigate", { url }, signal, bound.documentId);
  }
  async close(): Promise<void> {
    this.closed = true; this.generation++; this.pairing = undefined; await this.ready; await this.listening?.catch(() => {}); this.disconnect();
    for (const socket of this.sockets?.clients ?? []) socket.terminate();
    await new Promise<void>(resolve => { if (this.sockets) this.sockets.close(() => resolve()); else resolve(); });
    await new Promise<void>(resolve => { if (this.server) this.server.close(() => resolve()); else resolve(); });
    this.sockets = undefined; this.server = undefined; await this.writes.catch(() => {});
  }
}
