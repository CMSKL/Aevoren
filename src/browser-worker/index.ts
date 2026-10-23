import { chownSync, chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { isIP } from "node:net";
import { BrowserWorker } from "./browser-worker";
import { EngineClient } from "./engine-client";
import { Desktop } from "./desktop";
import { createBrowserServer } from "./server";
import { browserDownloadSchema, browserDownloadFailureSchema } from "@shared/browser-schemas";

const environmentId = z.string().uuid().parse(process.env.AEVOREN_BROWSER_ENVIRONMENT_ID);
const browserSessionId = z.string().uuid().parse(process.env.AEVOREN_BROWSER_SESSION_ID);
const token = z.string().regex(/^[a-f0-9]{64}$/u).parse(process.env.AEVOREN_BROWSER_TOKEN);
const previewExecutionIp = process.env.AEVOREN_PREVIEW_EXECUTION_IP;
if (previewExecutionIp && isIP(previewExecutionIp) !== 4) throw new Error("Preview target must be an owned IPv4 address");
const unified = process.env.AEVOREN_COMPUTER_LAYOUT === "2";
const stateDirectory = "/var/lib/aevoren-browser-state", profileDirectory = unified ? "/home/aevoren/.config/chromium" : "/var/lib/aevoren-browser-profile", downloadsDirectory = unified ? "/workspace/Downloads" : "/var/lib/aevoren-browser-downloads";
// The execution container may create these volumes first. Keep parents owned by
// the bootstrap process until their children are ready, then hand them to the
// desktop user in reverse order. No DAC override capability is needed.
const ownedDirectories: string[] = [], originalGroup = process.getegid!();
process.setegid!(1_000);
try {
  for (const directory of [...unified ? ["/home/aevoren", "/home/aevoren/.config"] : [], stateDirectory, profileDirectory, downloadsDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory() || ![0, 1_000].includes(info.uid)) throw new Error("Browser volume ownership is invalid");
    if (directory === stateDirectory && info.uid !== 0) throw new Error("Browser state ownership is invalid");
    if (info.uid !== 0) chownSync(directory, 0, 0);
    chmodSync(directory, 0o700);
    if (directory !== stateDirectory) ownedDirectories.push(directory);
  }
} finally {
  for (const directory of ownedDirectories.reverse()) chownSync(directory, 1_000, 1_000);
  process.setegid!(originalGroup);
}
if (unified) { mkdirSync("/tmp/.X11-unix", { recursive: true }); chmodSync("/tmp/.X11-unix", 0o1777); }
process.umask(0o077);
const desktop = new Desktop();
await desktop.start();
const engine = new EngineClient({ enginePath: join(dirname(fileURLToPath(import.meta.url)), "engine.mjs"), browserSessionId, environmentId, previewExecutionIp, profileDirectory, downloadsDirectory,
  onDownload: (record, lease) => {
    const control = worker.store.control();
    const valid = browserDownloadSchema.safeParse({ ...record, browserSessionId, mimeType: "application/octet-stream" });
    if (!valid.success || !lease || lease.epoch !== control.epoch || lease.owner !== control.owner) {
      if (z.string().uuid().safeParse(record.id).success) void engine.request("discard-download", { id: record.id }).catch(() => undefined);
      return;
    }
    worker.store.addDownload(valid.data);
  }, onDownloadFailure: (record, lease) => {
    const control = worker.store.control();
    const valid = browserDownloadFailureSchema.safeParse(record);
    if (valid.success && lease?.epoch === control.epoch && lease.owner === control.owner) worker.store.addDownloadFailure(valid.data);
  }, onStopped: () => worker.engineStopped() });
const worker = new BrowserWorker({ environmentId, browserSessionId, stateDirectory, downloadsDirectory }, engine);
await engine.start(worker.store.control());
worker.acknowledgeControl();
const server = createBrowserServer(worker, token);
server.listen(8_081, "0.0.0.0");
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  if (stopping) return;
  stopping = true; server.close(); server.closeAllConnections();
  void worker.close().finally(() => { desktop.close(); process.exit(0); });
});
