import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { shell, systemPreferences } from "electron";
import { z } from "zod";
import type { HostAppContext, HostAppTarget, HostComputerTarget } from "@shared/host-computer-targets";
import type { HostComputerPlatform } from "./host-computer-service";
import { imageDimensions } from "../browser-worker/image";
import { AevorenBotError } from "./errors";

const targetSchema = z.object({ kind: z.literal("app"), pid: z.number().int().positive(), startedAt: z.number().finite().positive(), windowId: z.number().int().positive(), appName: z.string().max(240), title: z.string().max(500) }).strict();
const contextSchema = z.object({ kind: z.literal("app"), target: targetSchema, x: z.number().finite(), y: z.number().finite(), width: z.number().finite().positive(), height: z.number().finite().positive() }).strict();
type HelperReply = { ok: boolean; code?: string; context?: HostAppContext; accessibility?: boolean; targets?: HostAppTarget[]; capture?: { dataBase64: string; width: number; height: number } };
function appTarget(target: HostComputerTarget): HostAppTarget {
  if (!target) throw new AevorenBotError("HOST_COMPUTER_TARGET_REQUIRED");
  if (target.kind !== "app") throw new AevorenBotError("HOST_COMPUTER_ACTION_UNSUPPORTED");
  const parsed = targetSchema.safeParse(target);
  if (!parsed.success) throw new AevorenBotError("HOST_COMPUTER_TARGET_REQUIRED");
  return parsed.data;
}
function readContext(value: unknown, target: HostAppTarget): HostAppContext {
  const parsed = contextSchema.safeParse(value);
  if (!parsed.success || parsed.data.target.pid !== target.pid || parsed.data.target.startedAt !== target.startedAt || parsed.data.target.windowId !== target.windowId) throw new AevorenBotError("HOST_COMPUTER_TARGET_CHANGED");
  return parsed.data;
}
function unchanged(before: HostAppContext, after: HostAppContext): boolean {
  return before.target.pid === after.target.pid && before.target.startedAt === after.target.startedAt && before.target.windowId === after.target.windowId
    && before.x === after.x && before.y === after.y && before.width === after.width && before.height === after.height;
}

export function createMacComputerPlatform(helperPath: string): HostComputerPlatform {
  const invoke = (value: Record<string, unknown>, signal: AbortSignal): Promise<HelperReply> => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = false, started = false;
    const readOnly = ["status", "listTargets", "capture"].includes(String(value.operation));
    const maximum = value.operation === "capture" ? 3_000_000 : value.operation === "listTargets" ? 512_000 : 16_000;
    const cancel = (): void => { child.kill("SIGTERM"); };
    signal.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); if (output.length > maximum) { error = true; cancel(); } });
    child.stderr.resume();
    child.once("spawn", () => { started = true; });
    child.once("error", () => { error = true; });
    child.once("close", (code, terminationSignal) => {
      signal.removeEventListener("abort", cancel);
      if (signal.aborted) { reject(signal.reason); return; }
      const failureCode = readOnly || !started ? "BROWSER_UNAVAILABLE" : "TOOL_STATE_INVALID";
      try {
        if (error || terminationSignal) throw new AevorenBotError(failureCode);
        const result = JSON.parse(output) as HelperReply;
        if (result.ok !== true) {
          switch (result.code) {
            case "HOST_COMPUTER_TARGET_REQUIRED": case "HOST_COMPUTER_TARGET_CHANGED": case "HOST_COMPUTER_ACTION_UNSUPPORTED":
            case "HOST_COMPUTER_PERMISSION": case "BROWSER_OBSERVATION_REQUIRED": case "INVALID_REQUEST": case "BROWSER_MEDIA_INVALID": case "TOOL_STATE_INVALID":
              throw new AevorenBotError(result.code);
            default: throw new AevorenBotError(failureCode);
          }
        }
        if (code !== 0) throw new AevorenBotError(failureCode);
        resolve(result);
      } catch (failure) { reject(failure instanceof AevorenBotError ? failure : new AevorenBotError(failureCode)); }
    });
    child.stdin.on("error", () => {}); child.stdin.end(JSON.stringify(value));
    if (signal.aborted) cancel();
  });
  return {
    status() { return { supported: process.platform === "darwin", helperAvailable: process.platform === "darwin" && existsSync(helperPath), screenPermission: process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("screen") : "unsupported", accessibility: process.platform === "darwin" && systemPreferences.isTrustedAccessibilityClient(false) }; },
    async permission(kind) {
      if (process.platform !== "darwin") throw new AevorenBotError("HOST_COMPUTER_PERMISSION");
      if (kind === "accessibility") { systemPreferences.isTrustedAccessibilityClient(true); await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"); }
      else await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
    },
    async listTargets(signal) {
      if (process.platform !== "darwin") throw new AevorenBotError("HOST_COMPUTER_ACTION_UNSUPPORTED");
      const result = await invoke({ operation: "listTargets" }, signal), parsed = z.array(targetSchema).max(128).safeParse(result.targets);
      if (!parsed.success) throw new AevorenBotError("BROWSER_UNAVAILABLE");
      return parsed.data;
    },
    async capture(target, signal) {
      const selected = appTarget(target);
      if (process.platform !== "darwin" || systemPreferences.getMediaAccessStatus("screen") !== "granted") throw new AevorenBotError("HOST_COMPUTER_PERMISSION");
      const initial = await invoke({ operation: "status", target: selected }, signal);
      if (!initial.accessibility) throw new AevorenBotError("HOST_COMPUTER_PERMISSION");
      const before = readContext(initial.context, selected), captured = await invoke({ operation: "capture", target: selected }, signal);
      const frameContext = readContext(captured.context, selected), after = readContext((await invoke({ operation: "status", target: selected }, signal)).context, selected);
      if (!unchanged(before, frameContext) || !unchanged(before, after)) throw new AevorenBotError("HOST_COMPUTER_TARGET_CHANGED");
      const frame = captured.capture;
      if (!frame || typeof frame.dataBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.dataBase64)) throw new AevorenBotError("BROWSER_MEDIA_INVALID");
      const bytes = Buffer.from(frame.dataBase64, "base64");
      if (!bytes.length || bytes.length > 2_097_152 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new AevorenBotError("BROWSER_MEDIA_INVALID");
      try {
        const dimensions = imageDimensions(bytes, "image/jpeg");
        if (dimensions.width !== frame.width || dimensions.height !== frame.height || frame.width > 1600 || frame.height > 1600) throw new Error("Invalid dimensions");
      } catch { throw new AevorenBotError("BROWSER_MEDIA_INVALID"); }
      signal.throwIfAborted();
      return { bytes, width: frame.width, height: frame.height, context: after };
    },
    async input(operation, input, context, signal) {
      const target = appTarget(context?.target);
      if (context?.kind !== "app") throw new AevorenBotError("HOST_COMPUTER_ACTION_UNSUPPORTED");
      const bound = readContext(context, target);
      await invoke({ ...input, operation, context: bound }, signal);
    },
  };
}
