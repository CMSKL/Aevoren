import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { AppRepository } from "../../src/main/database";
import { closeTestApplicationWithExit, removeTestDirectory } from "./test-cleanup";
import { selectNavigationTab } from "./navigation";

test("keeps an existing content team after restart without exposing the retired folder-based template", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-legacy-team-"));
  const databasePath = join(userDataDir, "aevoren-bot.sqlite");
  const repository = new AppRepository(databasePath);
  const team = repository.createContentTeamTemplate();
  repository.setSetting("memory.capture.enabled", "false", false);
  repository.close();
  const environment = { ...process.env, AEVOREN_BOT_USER_DATA_DIR: userDataDir, AEVOREN_BOT_FAKE_PROVIDER: "1", AEVOREN_BOT_DISABLE_UPDATES: "1" };
  let application: ElectronApplication | undefined;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment });
      const page = await application.firstWindow();
      await expect(page.locator(".app-shell")).toBeVisible();
      await selectNavigationTab(page, "联系人");
      for (const bot of team.bots) await expect(page.getByRole("listitem", { name: bot.name, exact: true })).toHaveCount(1);
      await selectNavigationTab(page, "聊天");
      await expect(page.getByRole("listitem", { name: team.room.room.name, exact: true })).toBeVisible();
      await page.getByRole("button", { name: "新建聊天", exact: true }).click();
      await expect(page.getByRole("button", { name: "一键创建内容团队", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "关闭新聊天", exact: true }).click();
      await closeTestApplicationWithExit(application);
      application = undefined;
    }
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare("SELECT COUNT(*) AS count FROM bots WHERE deleted_at IS NULL").get()).toEqual({ count: 5 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM rooms").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM room_members").get()).toEqual({ count: 5 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { database.close(); }
  } finally {
    if (application) await closeTestApplicationWithExit(application);
    removeTestDirectory(userDataDir);
  }
});
