import { removeTestDirectory } from "./test-cleanup";
import { openBotList, openContactsTab, selectNavigationTab } from "./navigation";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import type { AevorenBotApi } from "@shared/contracts";
import { DEFAULT_PROJECT_ID } from "@shared/contracts";
import { AppRepository } from "../../src/main/database";

function environment(userDataDir: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    AEVOREN_BOT_USER_DATA_DIR: userDataDir,
    AEVOREN_BOT_FAKE_PROVIDER: "1",
    ...overrides,
  };
}

async function launch(userDataDir: string, overrides: Record<string, string> = {}): Promise<{ application: ElectronApplication; page: Page }> {
  const application = await electron.launch({ args: ["."], cwd: process.cwd(), env: environment(userDataDir, overrides) });
  return { application, page: await application.firstWindow() };
}

function row(page: Page, name: string): Locator {
  return page.locator(`.bot-row[aria-label="${name}"]`);
}

function multiSelected(page: Page): Locator {
  return page.locator('.bot-row[data-multi-selected="true"]');
}

test("matches compact messenger-style Shift ranges, batch context menus, cancellation, and contact deletion without project navigation", async () => {
  test.setTimeout(90_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-sidebar-multiselect-"));
  let application: ElectronApplication | undefined;
  try {
    const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
    const memberA = repository.createBot(DEFAULT_PROJECT_ID);
    repository.updateBot(memberA.bot.id, memberA.bot.version, { name: "成员甲" });
    const memberB = repository.createBot(DEFAULT_PROJECT_ID);
    repository.updateBot(memberB.bot.id, memberB.bot.version, { name: "成员乙" });
    for (const name of ["Bot A", "Bot B", "Bot C", "Bot D"]) {
      const created = repository.createBot(DEFAULT_PROJECT_ID);
      repository.updateBot(created.bot.id, created.bot.version, { name });
    }
    for (const name of ["群聊一", "群聊二", "群聊三"]) {
      repository.createRoom({ memberBotIds: [memberA.bot.id, memberB.bot.id], name, projectId: DEFAULT_PROJECT_ID });
    }
    repository.close();

    const launched = await launch(userDataDir);
    application = launched.application;
    const page = launched.page;
    const consoleErrors: string[] = [];
    await openContactsTab(page);
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    const invalidBatch = await page.evaluate((id) =>
      (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.conversations.deleteBatch({ botIds: [id], roomIds: [] }), memberA.bot.id);
    expect(invalidBatch).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });

    await row(page, "Bot A").click();
    await row(page, "Bot C").click({ modifiers: ["Shift"] });
    await expect(multiSelected(page)).toHaveCount(3);
    await expect(multiSelected(page)).toHaveText(["Bot A未设置标签", "Bot B未设置标签", "Bot C未设置标签"]);
    await expect(page.getByText("已选择 3 项", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "删除已选择的 3 项" }).click();
    let dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("删除 3 个联系人？");
    await page.keyboard.press("Escape");
    await expect(multiSelected(page)).toHaveCount(3);

    await row(page, "Bot B").click({ button: "right" });
    let batchMenu = page.getByRole("menu", { name: "批量操作" });
    await expect(batchMenu.getByRole("menuitem")).toHaveText("删除 3 个联系人");
    await page.screenshot({ path: "/tmp/aevoren-sidebar-multiselect-bots.png", fullPage: true });
    await batchMenu.getByRole("menuitem").click();
    dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("删除 3 个联系人？");
    await expect(dialog).toContainText("将它们移出群聊");
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(multiSelected(page)).toHaveCount(3);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(390, 844));
    await openBotList(page);
    await row(page, "Bot B").click({ button: "right" });
    batchMenu = page.getByRole("menu", { name: "批量操作" });
    const compactBounds = await batchMenu.boundingBox();
    expect(compactBounds).not.toBeNull();
    expect(compactBounds!.x).toBeGreaterThanOrEqual(8);
    expect(compactBounds!.y).toBeGreaterThanOrEqual(8);
    expect(compactBounds!.x + compactBounds!.width).toBeLessThanOrEqual(382);
    expect(compactBounds!.y + compactBounds!.height).toBeLessThanOrEqual(836);
    await page.screenshot({ path: "/tmp/aevoren-sidebar-multiselect-compact.png", fullPage: true });
    await page.keyboard.press("Escape");
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1040, 707));
    await page.keyboard.press("Escape");
    await expect(multiSelected(page)).toHaveCount(0);

    await row(page, "Bot D").click();
    await row(page, "Bot B").click({ modifiers: ["Shift"] });
    await expect(multiSelected(page)).toHaveText(["Bot B未设置标签", "Bot C未设置标签", "Bot D未设置标签"]);
    await page.keyboard.press("Delete");
    await expect(page.getByRole("alertdialog")).toContainText("删除 3 个联系人？");
    await page.keyboard.press("Escape");
    await expect(multiSelected(page)).toHaveCount(3);
    await row(page, "Bot A").click({ modifiers: ["Meta"] });
    await expect(multiSelected(page)).toHaveCount(4);
    await row(page, "Bot C").click({ modifiers: ["Meta"] });
    await expect(multiSelected(page)).toHaveText(["Bot A未设置标签", "Bot B未设置标签", "Bot D未设置标签"]);
    await row(page, "Bot A").click();
    await expect(multiSelected(page)).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Bot A" })).toBeVisible();

    await row(page, "Bot B").click();
    await row(page, "Bot D").click({ modifiers: ["Shift"] });
    await row(page, "Bot C").click({ button: "right" });
    await page.getByRole("menu", { name: "批量操作" }).getByRole("menuitem").click();
    dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    await expect(row(page, "Bot B")).toHaveCount(0);
    await expect(row(page, "Bot C")).toHaveCount(0);
    await expect(row(page, "Bot D")).toHaveCount(0);
    await row(page, "成员甲").click();
    await expect(page.getByRole("heading", { name: "成员甲" })).toBeVisible();
    await expect(multiSelected(page)).toHaveCount(0);
    expect(consoleErrors).toEqual([]);

    const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM rooms").get()).toEqual({ count: 3 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM bots WHERE deleted_at IS NULL").get()).toEqual({ count: 3 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM bots WHERE deleted_at IS NOT NULL").get()).toEqual({ count: 3 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});

test("keeps the entire batch and selection when one selected Bot is running", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-sidebar-multiselect-busy-"));
  let application: ElectronApplication | undefined;
  try {
    const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
    const busy = repository.createBot(DEFAULT_PROJECT_ID);
    repository.updateBot(busy.bot.id, busy.bot.version, { name: "运行中 Bot" });
    const other = repository.createBot(DEFAULT_PROJECT_ID);
    repository.updateBot(other.bot.id, other.bot.version, { name: "同行 Bot" });
    repository.close();

    const launched = await launch(userDataDir, { AEVOREN_BOT_FAKE_START_DELAY_MS: "30000" });
    application = launched.application;
    const page = launched.page;
    await page.getByLabel("消息").fill("保持运行");
    await page.getByRole("button", { name: "发送" }).click();
    await expect(page.getByRole("button", { name: "停止回复" })).toBeVisible();
    await openContactsTab(page);
    await row(page, "运行中 Bot").click({ modifiers: ["Meta"] });
    await row(page, "同行 Bot").click({ modifiers: ["Meta"] });
    await expect(multiSelected(page)).toHaveCount(2);

    await row(page, "运行中 Bot").click({ button: "right" });
    await page.getByRole("menu", { name: "批量操作" }).getByRole("menuitem").click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(page.getByText("该 Bot 正在运行，暂时不能删除。")).toBeVisible();
    await expect(multiSelected(page)).toHaveCount(2);
    await expect(row(page, "运行中 Bot")).toBeVisible();
    await expect(row(page, "同行 Bot")).toBeVisible();
    await dialog.getByRole("button", { name: "取消" }).click();
    await selectNavigationTab(page, "聊天");
    await page.getByRole("button", { name: "停止回复" }).click();

    const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM bots WHERE deleted_at IS NOT NULL").get()).toEqual({ count: 0 });
    database.close();
  } finally {
    if (application) application.process().kill("SIGKILL");
    removeTestDirectory(userDataDir);
  }
});
