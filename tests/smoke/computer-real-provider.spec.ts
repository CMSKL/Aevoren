import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { AppRepository } from "../../src/main/database";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { closeTestApplicationWithExit } from "./test-cleanup";

// Explicitly opted in: actual configured providers, real Docker and public-free
// controlled pages. Only connection rows/ciphertext are copied, never history.
for (const providerId of ["openai-compatible.default", "claude.default", "codex.default"]) test(`actual computer task through ${providerId}`, async () => {
  test.skip(process.env.AEVOREN_REAL_COMPUTER !== "1", "requires real configured models and local Docker");
  test.setTimeout(360_000);
  const sourcePath = process.env.AEVOREN_REAL_COMPUTER_SOURCE_DB;
  if (!sourcePath) throw new Error("An explicit read-only source profile is required");
  const directory = mkdtempSync(join(tmpdir(), "aevoren-real-computer-")), database = join(directory, "aevoren-bot.sqlite");
  const repository = new AppRepository(database), created = repository.createBot(); repository.setSetting("memory.capture.enabled", "false", false); repository.close();
  const source = new DatabaseSync(sourcePath, { readOnly: true }), destination = new DatabaseSync(database);
  let configuredModel: string;
  try {
    const connection = source.prepare("SELECT * FROM provider_instances WHERE id=?").get(providerId);
    const credential = providerId === "openai-compatible.default" ? source.prepare("SELECT * FROM app_settings WHERE key=? AND encrypted=1").get(`provider.${providerId}.apiKey`) : undefined;
    if (connection) for (const [table, row] of [["provider_instances", connection], ...credential ? [["app_settings", credential] as const] : []] as const) {
      const keys = Object.keys(row); destination.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(key => row[key]!));
    }
    const model = source.prepare("SELECT model_id FROM bots WHERE provider_instance_id=? AND model_id<>'' ORDER BY (deleted_at IS NULL) DESC,updated_at DESC LIMIT 1").get(providerId) as { model_id: string } | undefined;
    configuredModel = model?.model_id ?? "";
  } finally { destination.close(); source.close(); }
  let clicked = 0;
  const marker = `VERIFIED_${randomUUID().slice(0, 8)}`;
  const server = createServer((request, response) => {
    if (request.url === "/clicked") { clicked++; response.writeHead(200).end(marker); return; }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<title>Controlled computer acceptance</title><body style="font:30px sans-serif;background:#eff4fb;padding:60px"><h1>Computer acceptance</h1><button style="font:28px sans-serif;padding:30px" onclick="fetch('/clicked').then(r=>r.text()).then(t=>{this.textContent=t;this.disabled=true})">Verify this computer</button></body>`);
  });
  await new Promise<void>(resolve => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as { port: number }).port;
  const environment: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), AEVOREN_BOT_USER_DATA_DIR: directory, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_FAKE_PROVIDER: "0" }; delete environment.AEVOREN_BOT_DB_PATH;
  let application: ElectronApplication | undefined;
  let receipt: unknown;
  try {
    application = await electron.launch({ ...(process.env.AEVOREN_PACKAGED_APP_PATH ? { executablePath: process.env.AEVOREN_PACKAGED_APP_PATH, args: [] } : { args: ["."] }), cwd: process.cwd(), env: environment });
    const page = await application.firstWindow(); await page.waitForURL(/\/out\/renderer\/index\.html$/u); await page.waitForFunction(() => Boolean((window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot));
    const selection = await page.evaluate(async ({ providerId, configuredModel }) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const providers = await api.providers.list(); if (!providers.ok) throw new Error(providers.error.code);
      const provider = providers.data.find(value => value.id === providerId);
      if (!provider || provider.status !== "available") throw new Error(`Provider unavailable: ${providerId}/${provider?.reason}`);
      const model = configuredModel || provider.models.default;
      const configuration = await api.computerModel.get(); if (!configuration.ok) throw new Error(configuration.error.code);
      const saved = await api.computerModel.save({ expectedVersion: configuration.data.version, selection: { providerInstanceId: providerId, modelId: model } });
      if (!saved.ok) throw new Error(saved.error.code);
      return saved.data.selection;
    }, { providerId, configuredModel });
    const scope = { sessionId: created.session.id, executorBotId: created.bot.id };
    const started = await page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.computerTasks.start(input), {
      ...scope, clientNonce: randomUUID(), goal: `请使用你自己的隔离电脑打开 http://host.docker.internal:${port}/ ，在网页上点击 Verify this computer 按钮一次，观察按钮显示的验证编号并确认完成。必须通过浏览器或桌面点击，不要使用终端、脚本或直接请求接口。只访问这一个受控页面。`,
    });
    if (!started.ok) throw new Error(`${started.error.code}: ${started.error.safeMessage}`);
    let detail;
    await expect.poll(async () => {
      const result = await page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.computerTasks.get(input), { ...scope, id: started.data.id });
      if (!result.ok) throw new Error(result.error.code); detail = result.data;
      return ["completed", "failed", "paused", "waiting_user", "cancelled", "interrupted"].includes(result.data.task.state);
    }, { timeout: 240_000, intervals: [500] }).toBe(true);
    const result = await page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.computerTasks.get(input), { ...scope, id: started.data.id });
    if (!result.ok) throw new Error(result.error.code);
    receipt = { providerId, selection, clicked, detail: result.data };
    expect(result.data.task.state, JSON.stringify(result.data.task)).toBe("completed"); expect(clicked).toBe(1);
    expect(result.data.steps.some(step => ["browser.click", "computer.click"].includes(step.operation) && step.state === "completed")).toBe(true);
    expect(result.data.steps.some(step => step.operation === "computer.screenshot" && step.state === "completed")).toBe(true);
    expect(detail).toBeDefined();
  } catch (error) { receipt = { providerId, error: error instanceof Error ? error.message : String(error), receipt }; throw error; }
  finally {
    const evidence = test.info().outputPath("actual-computer-model.json"); writeFileSync(evidence, JSON.stringify(receipt, null, 2)); await test.info().attach("actual-computer-model", { path: evidence, contentType: "application/json" });
    try { if (application) await closeTestApplicationWithExit(application); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    // Keep this independent profile and owned Docker scopes for diagnostic
    // cleanup after all receipts are inspected; never touch the source profile.
  }
});
