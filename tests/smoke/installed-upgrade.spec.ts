import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { MIGRATIONS } from "../../src/main/database";
import type { AevorenBotApi, ApiResult } from "../../src/shared/contracts";
import { closeTestApplication, removeTestDirectory } from "./test-cleanup";

const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;
const expectedSchemaVersion = MIGRATIONS.at(-1)!.version;
function value<T>(result: ApiResult<T>): T { if (!result.ok) throw new Error(result.error.code); return result.data; }
function snapshot(path: string): Record<string, Record<string, unknown>[]> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(["bots", "transcript_entries", "memory_items", "message_attachments", "runtime_runs", "send_journal"].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  } finally { db.close(); }
}
function schemaVersion(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return (db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version; } finally { db.close(); }
}
function tableReceipts(data: ReturnType<typeof snapshot>) {
  return Object.fromEntries(Object.entries(data).map(([table, rows]) => [table, { rows: rows.length, sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex") }]));
}
function macBundle(executablePath: string): string {
  const matched = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/u.exec(executablePath);
  if (!matched) throw new Error("The macOS upgrade requires an actual .app executable");
  return matched[1]!;
}

const baselineVersion = process.env.AEVOREN_UPGRADE_BASELINE_VERSION ?? "0.3.0-beta.40";

test("upgrades an actual prior application and preserves chat, Memory, attachment and Runtime", async () => {
  const baseline = process.env.AEVOREN_UPGRADE_BASELINE_APP_PATH, current = process.env.AEVOREN_PACKAGED_APP_PATH;
  test.skip(!baseline || !current, "Requires actual baseline and candidate packages; source/fixture launch is not an installer upgrade.");
  test.setTimeout(180_000);
  const directory = mkdtempSync(join(tmpdir(), "aevoren-installed-upgrade-"));
  const profile = join(directory, "profile"); mkdirSync(profile);
  const databasePath = join(profile, "app.sqlite");
  const environment = { ...process.env, AEVOREN_BOT_USER_DATA_DIR: profile, AEVOREN_BOT_DB_PATH: databasePath, AEVOREN_BOT_FAKE_PROVIDER: "1", AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1" };
  const closeEvents: { version: string; normalExit: boolean; code: number | null; signal: NodeJS.Signals | null }[] = [];
  const receipt: Record<string, unknown> = { baseline: baselineVersion, candidate: version, platform: process.platform, installerUpgrade: Boolean(process.env.AEVOREN_UPGRADE_INSTALLER),
    upgradeMechanism: process.platform === "darwin" ? "isolated-bundle-replacement" : process.env.AEVOREN_UPGRADE_INSTALLER ? "nsis-installer" : "separate-packaged-launch", businessCompleted: false,
    validation: { syntheticProfile: true, simulatedModel: true, realModel: false, automaticUpdater: false, gatekeeper: false }, closeEvents };
  let application: ElectronApplication | undefined;
  let runningVersion = "";
  let baselineExecutable = baseline!, candidateExecutable = current!;
  const installedBundle = join(directory, "installation", "Aevoren Bot.app");
  const launch = async (executablePath: string, expectedVersion: string): Promise<ElectronApplication> => {
    const app = await electron.launch({ executablePath, args: ["--use-mock-keychain"], env: environment });
    application = app; runningVersion = expectedVersion;
    expect(await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))).toEqual({ packaged: true, version: expectedVersion });
    const page = await app.firstWindow();
    await page.waitForURL(/\/out\/renderer\/index\.html$/u, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".app-shell")).toBeVisible();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
    return app;
  };
  const close = async (): Promise<void> => {
    if (!application) return;
    const closing = application;
    application = undefined;
    const owned = closing.process();
    let normalExit = false;
    try { await closeTestApplication(closing); expect({ code: owned.exitCode, signal: owned.signalCode }).toEqual({ code: 0, signal: null }); normalExit = true; }
    finally { closeEvents.push({ version: runningVersion, normalExit, code: owned.exitCode, signal: owned.signalCode }); }
  };
  try {
    if (process.platform === "darwin") {
      mkdirSync(join(directory, "installation"));
      // Read the real installed baseline; only this private copy is replaced.
      execFileSync("ditto", [macBundle(baseline!), installedBundle], { stdio: "pipe" });
      baselineExecutable = join(installedBundle, "Contents", "MacOS", basename(baseline!));
      candidateExecutable = join(installedBundle, "Contents", "MacOS", basename(current!));
      receipt.packageInputs = { baselineAppAsarSha256: createHash("sha256").update(readFileSync(join(macBundle(baseline!), "Contents", "Resources", "app.asar"))).digest("hex"),
        candidateAppAsarSha256: createHash("sha256").update(readFileSync(join(macBundle(current!), "Contents", "Resources", "app.asar"))).digest("hex") };
    }
    const old = await launch(baselineExecutable, baselineVersion), page = await old.firstWindow();
    const content = "# beta.40 upgrade attachment\nPersistent original bytes.\n";
    const attachment = { id: randomUUID(), name: "upgrade.md", kind: "text" as const, mimeType: "text/markdown", size: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex"), content };
    const created = value(await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.bots.create()));
    value(await page.evaluate(async ({ bot, sessionId, attachment }) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const changed = await api.bots.update({ id: bot.id, expectedVersion: bot.version, patch: { name: "beta.40 升级保留", modelSelection: { providerInstanceId: "openai-compatible.default", modelId: "upgrade-model" } } });
      if (!changed.ok) return changed;
      const memory = await api.memories.create({ botId: bot.id, content: "升级后保留原 Memory", kind: "preference" });
      if (!memory.ok) return memory;
      const settings = await api.settings.saveGeneral({ theme: "dark", memoryCaptureEnabled: false });
      if (!settings.ok) return settings;
      return api.messages.send({ sessionId, clientNonce: crypto.randomUUID(), text: "保留这条原始升级验收消息。", attachments: [attachment] });
    }, { bot: created.bot, sessionId: created.session.id, attachment }));
    await expect.poll(async () => {
      const result = await page.evaluate(id => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.runtime.getSessionSnapshot(id), created.session.id);
      return result.ok ? result.data.runs.at(-1)?.state : null;
    }).toBe("completed");
    await close();
    const before = snapshot(databasePath); receipt.beforeSchemaVersion = schemaVersion(databasePath); receipt.before = tableReceipts(before);
    for (const rows of Object.values(before)) expect(rows.length).toBeGreaterThan(0);
    expect(before.message_attachments!.find(row => row.id === attachment.id)?.content).toBe(content);
    receipt.attachmentSha256 = attachment.sha256;
    if (process.platform === "darwin") {
      const incoming = join(directory, "candidate.app");
      execFileSync("ditto", [macBundle(current!), incoming], { stdio: "pipe" });
      renameSync(installedBundle, join(directory, "baseline.app")); renameSync(incoming, installedBundle);
      const copied = createHash("sha256").update(readFileSync(join(installedBundle, "Contents", "Resources", "app.asar"))).digest("hex");
      expect(copied).toBe((receipt.packageInputs as { candidateAppAsarSha256: string }).candidateAppAsarSha256);
    }
    if (process.env.AEVOREN_UPGRADE_INSTALLER) {
      // Both paths are fixed CI-owned inputs; PowerShell waits for NSIS and its
      // descendants instead of treating the launcher's early exit as completion.
      execFileSync("pwsh", ["-NoProfile", "-Command", "$p = Start-Process -FilePath $env:AEVOREN_UPGRADE_INSTALLER -ArgumentList @('/S', ('/D=' + $env:AEVOREN_UPGRADE_INSTALL_DIR)) -Wait -PassThru; if ($p.ExitCode -ne 0) { throw 'Candidate upgrade installation failed' }"], { env: process.env, timeout: 90_000, stdio: "pipe" });
    }
    const upgraded = await launch(candidateExecutable, version), upgradedPage = await upgraded.firstWindow();
    const after = snapshot(databasePath); receipt.afterSchemaVersion = schemaVersion(databasePath); receipt.after = tableReceipts(after);
    receipt.expectedSchemaVersion = expectedSchemaVersion;
    expect(after).toEqual(before);
    expect(receipt.beforeSchemaVersion).toBeLessThanOrEqual(expectedSchemaVersion);
    expect(receipt.afterSchemaVersion).toBe(expectedSchemaVersion);
    const settings = value(await upgradedPage.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.settings.getGeneral()));
    expect(settings.theme).toBe("dark");
    const bots = value(await upgradedPage.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.bots.list()));
    expect(bots.find(bot => bot.id === created.bot.id)?.modelSelection).toEqual({ providerInstanceId: "openai-compatible.default", modelId: "upgrade-model" });
    await close();
    expect(snapshot(databasePath)).toEqual(before); receipt.preservedTables = Object.keys(before); receipt.businessCompleted = true;
  } catch (error) {
    receipt.error = error instanceof Error ? error.message : String(error); throw error;
  } finally {
    try { await close(); } finally {
      const path = test.info().outputPath("actual-installed-upgrade.json"); writeFileSync(path, JSON.stringify(receipt, null, 2));
      await test.info().attach("actual-installed-upgrade", { path, contentType: "application/json" }); removeTestDirectory(directory);
    }
  }
});
