import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { closeTestApplicationWithExit, removeTestDirectory } from "./test-cleanup";

test("opens a preview profile whose migration 43 belongs to another feature", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-preview-startup-"));
  const filename = join(directory, "aevoren-bot.sqlite");
  const repository = new AppRepository(filename);
  const { bot, session } = repository.createBot();
  repository.close();
  const raw = new DatabaseSync(filename);
  try {
    raw.exec(`
      DROP TABLE computer_task_steps; DROP TABLE computer_tasks;
      DROP TABLE computer_model_settings; DROP TABLE computer_application_launches;
      DROP TABLE computer_applications; DROP TABLE computer_layout_migrations;
      ALTER TABLE browser_sessions DROP COLUMN desktop_observation_id;
      ALTER TABLE browser_screenshots DROP COLUMN desktop_json;
      DELETE FROM schema_migrations WHERE version >= 43;
    `);
    for (let version = 43; version <= 47; version++) {
      raw.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(version, "2026-10-17T14:59:50.000Z");
    }
  } finally { raw.close(); }
  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: { ...process.env,
    AEVOREN_BOT_USER_DATA_DIR: directory, AEVOREN_BOT_FAKE_PROVIDER: "1", AEVOREN_BOT_DISABLE_UPDATES: "1" } });
  try {
    const page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();
    const result = await page.evaluate(async scope => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      return { bots: await api.bots.list(), model: await api.computerModel.get(),
        applications: await api.applications.list(scope), tasks: await api.computerTasks.list(scope) };
    }, { sessionId: session.id, executorBotId: bot.id });
    expect(result.bots).toMatchObject({ ok: true, data: [expect.objectContaining({ id: bot.id })] });
    expect(result.model).toMatchObject({ ok: true });
    expect(result.applications).toEqual({ ok: true, data: [] });
    expect(result.tasks).toEqual({ ok: true, data: [] });
  } finally {
    await closeTestApplicationWithExit(application);
    removeTestDirectory(directory);
  }
});
