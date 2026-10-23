import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { verifyComputerModel } from "./computer-model-probe";
import type { ModelEvent, ModelProvider } from "./model";
import type { ModelImageAttachment } from "./model-image";
import { ClaudeCliProvider, inspectClaudeCli } from "./providers/claude-cli";

type Entry = { elapsedMs: number; type: string; [key: string]: unknown };
function imageReceipt(image: ModelImageAttachment) {
  const bytes = Buffer.from(image.dataBase64, "base64"), compressed: Buffer[] = [];
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset), kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (kind === "IDAT") compressed.push(bytes.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), raw = inflateSync(Buffer.concat(compressed)), stride = width * 3 + 1;
  expect({ width, height }).toEqual({ width: 300, height: 100 });
  const actualOrder = [50, 150, 250].map(x => {
    const rgb = [...raw.subarray(50 * stride + 1 + x * 3, 50 * stride + 4 + x * 3)];
    return ["red", "green", "blue"][rgb.indexOf(Math.max(...rgb))];
  }).join(",");
  return { mimeType: image.reference.mimeType, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width, height, actualOrder, authorized: image.isAuthorized() };
}

function proxySnapshot(since: number) {
  const database = new DatabaseSync(join(homedir(), ".cc-switch", "cc-switch.db"), { readOnly: true });
  try {
    return {
      current: database.prepare("SELECT id,name FROM providers WHERE app_type='claude' AND is_current=1").all(),
      requests: database.prepare("SELECT request_id,provider_id,request_model,model,status_code,latency_ms,created_at FROM proxy_request_logs WHERE app_type='claude' AND created_at>=? AND request_model='k3' ORDER BY created_at").all(since),
    };
  } finally { database.close(); }
}

// Explicit diagnostic only. No history, Docker, desktop, setting edits or
// credential copies. Failure stays a failure of the unchanged product probe.
it.skipIf(process.env.AEVOREN_CLAUDE_PROBE_DIAGNOSTIC !== "1")("diagnoses the configured k3 Claude visual probe without weakening verification", async () => {
  const output = process.env.AEVOREN_CLAUDE_PROBE_EVIDENCE;
  if (!output) throw new Error("An explicit evidence output path is required");
  const started = Date.now(), directory = mkdtempSync(join(tmpdir(), "aevoren-claude-visual-diagnostic-"));
  const settingsPath = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
  const digest = () => createHash("sha256").update(readFileSync(settingsPath)).digest("hex");
  const settingsBefore = digest(), events: Entry[] = [];
  let inspection: Awaited<ReturnType<typeof inspectClaudeCli>> | undefined, outcome = "not-run";
  const record = (type: string, data: Record<string, unknown> = {}) => events.push({ elapsedMs: Date.now() - started, type, ...data });
  try {
    inspection = await inspectClaudeCli("claude");
    expect(inspection.authenticated).toBe(true); expect(inspection.hostToolsSupported).toBe(true);
    const provider = new ClaudeCliProvider(inspection.path, "k3", directory, inspection.hostToolsSupported);
    const traced: ModelProvider = {
      testConnection: signal => provider.testConnection(signal),
      async *run(messages, signal, context) {
        for await (const event of provider.run(messages, signal, context)) {
          if (event.type === "delta") record(event.type, { text: event.text.slice(0, 2_000) });
          else if (event.type === "project-tool") {
            record(event.type, { tool: event.tool, nativeResponse: Boolean(event.respond) });
            const respond = event.respond;
            yield { ...event, respond: respond ? async (content, images, modelText) => {
              record("host-response", { content, images: images?.map(imageReceipt) ?? [] });
              await respond(content, images, modelText);
            } : undefined } satisfies ModelEvent;
            continue;
          } else record(event.type);
          yield event;
        }
      },
    };
    await verifyComputerModel(traced, AbortSignal.timeout(120_000), { executorBotId: randomUUID(), executionKey: randomUUID() });
    outcome = "verified";
  } catch (error) {
    outcome = error instanceof Error ? `${(error as { code?: string }).code ?? error.name}: ${error.message}` : String(error);
    throw error;
  } finally {
    const settingsAfter = digest();
    const evidence = { modelRequested: "k3", syntheticPromptOnly: true, realCli: true, realModel: true, desktopOrDocker: false,
      unchangedUserSettings: settingsAfter === settingsBefore, inspection, outcome, events, proxy: proxySnapshot(Math.floor(started / 1_000) - 1) };
    writeFileSync(output, JSON.stringify(evidence, null, 2), { mode: 0o600 });
    rmSync(directory, { recursive: true, force: true });
    expect(settingsAfter).toBe(settingsBefore);
  }
}, 135_000);
