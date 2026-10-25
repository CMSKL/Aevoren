import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";
import { closeTestApplicationWithExit, removeTestDirectory } from "./test-cleanup";
import { closeInspector, openInspector, openSettingsFromAccount, selectNavigationTab } from "./navigation";

async function legacyData() {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-without-workspace-"));
  const root = join(directory, "old-files");
  mkdirSync(root);
  const file = join(root, "delivery.md");
  writeFileSync(file, "# Preserve existing files\n", "utf8");
  const databasePath = join(directory, "aevoren-bot.sqlite");
  const repository = new AppRepository(databasePath);
  try {
    for (const id of ["claude.default", "codex.default"]) {
      const configuration = repository.getProviderInstanceConfig(id);
      repository.updateProviderInstanceConfig(id, configuration.version, { ...configuration.config, cliPath: join(directory, `missing-${id}`) });
    }
    const registered = await new WorkspaceService(repository).registerRoot(root);
    repository.updateWorkspacePermissions(registered.workspace.id, registered.workspace.version, { writeEnabled: true, automationEnabled: true });
    const first = repository.createBot(registered.project.id);
    const bot = repository.updateBot(first.bot.id, first.bot.version, { name: "原有研究员", memoryWorkspaceIds: [registered.workspace.id] });
    const second = repository.createBot();
    repository.updateBot(second.bot.id, second.bot.version, { name: "原有编辑" });
    const room = repository.createRoom({ name: "原有协作群", projectId: registered.project.id, memberBotIds: [first.bot.id, second.bot.id] });
    const nonce = randomUUID();
    repository.prepareMessage({ sessionId: first.session.id, clientNonce: nonce, text: "需要保留的历史聊天。" });
    repository.acknowledgeUserMessage(nonce);
    const memory = repository.createScopedMemory({ scope: "workspace", scopeKey: registered.workspace.id }, "LEGACY_FOLDER_MEMORY_MUST_NOT_REENTER_CONTEXT");
    const userMemory = repository.createScopedMemory({ scope: "user", scopeKey: "user" }, "回答保持简洁。");
    repository.setSetting("memory.capture.enabled", "false", false);
    repository.setSetting("appearance.theme", "light", false);
    return { directory, databasePath, registered, bot, first, second, room, memory, userMemory, file };
  } finally { repository.close(); }
}

type Fixture = Awaited<ReturnType<typeof legacyData>>;

async function launch(fixture: Fixture): Promise<ElectronApplication> {
  return electron.launch({ args: ["."], cwd: process.cwd(), env: {
    ...process.env, AEVOREN_BOT_USER_DATA_DIR: fixture.directory,
    AEVOREN_BOT_DB_PATH: fixture.databasePath, AEVOREN_BOT_TEST_HIDDEN: "1",
    AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_FAKE_PROVIDER: "1",
  } });
}

function assertLegacyData(fixture: Fixture): void {
  const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
  try {
    expect(database.prepare("SELECT content FROM memory_items WHERE id = ?").get(fixture.memory.id)).toEqual({ content: fixture.memory.content });
    expect(database.prepare("SELECT archived_at FROM rooms WHERE id = ?").get(fixture.room.room.id)).toEqual({ archived_at: null });
    expect(database.prepare("SELECT removed_at FROM workspaces WHERE id = ?").get(fixture.registered.workspace.id)).toEqual({ removed_at: null });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(readFileSync(fixture.file, "utf8")).toBe("# Preserve existing files\n");
  } finally { database.close(); }
}

test("removes all workspace navigation and settings while preserving old chats, contacts and files", async ({ playwright: _playwright }, testInfo) => {
  test.setTimeout(90_000);
  const fixture = await legacyData();
  let application: ElectronApplication | undefined;
  try {
    application = await launch(fixture);
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await expect(page.locator(".app-shell")).toBeVisible();
    await page.getByRole("button", { name: "打开账户菜单", exact: true }).click();
    await expect(page.getByRole("tab", { name: "聊天", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "联系人", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "工作区", exact: true, includeHidden: true })).toHaveCount(0);
    await expect(page.locator(".nav-rail-tabs [role=tab]")).toHaveCount(2);
    await page.getByRole("tab", { name: "联系人", exact: true }).click();
    await expect(page.getByRole("listitem", { name: fixture.bot.name, exact: true })).toBeVisible();
    await expect(page.getByRole("listitem", { name: "原有编辑", exact: true })).toBeVisible();
    await expect(page.locator(".sidebar-workspace, .sidebar-project")).toHaveCount(0);
    await page.getByRole("listitem", { name: fixture.bot.name, exact: true }).click();
    await expect(page.getByRole("main", { name: "联系人资料", exact: true })).toBeVisible();
    await expect(page.getByText("文件夹记忆范围", { exact: true })).toHaveCount(0);
    await closeInspector(page);
    await selectNavigationTab(page, "聊天");
    await page.getByRole("listitem", { name: fixture.room.room.name, exact: true }).click();
    await openInspector(page);
    await expect(page.getByRole("combobox", { name: "当前聊天工作区", exact: true })).toHaveCount(0);
    await closeInspector(page);
    await openSettingsFromAccount(page);
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "能力与权限", exact: true }).click();
    await expect(settings.getByText("本地文件与聊天管理", { exact: true })).toHaveCount(0);
    await expect(settings.locator('[data-capability^="workspace."]')).toHaveCount(0);
    await settings.getByRole("button", { name: "长期记忆", exact: true }).click();
    await expect(settings.getByLabel(`Memory ${fixture.userMemory.id}`, { exact: true })).toHaveValue(fixture.userMemory.content);
    await expect(settings.getByRole("combobox", { name: "Memory 范围", exact: true })).toHaveCount(0);
    expect(await settings.locator("textarea").evaluateAll(elements => elements.map(element => (element as HTMLTextAreaElement).value))).not.toContain(fixture.memory.content);
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    const publicApi = await page.evaluate(() => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      return { workspaces: "workspaces" in api, projects: "projects" in api, setProject: "setProject" in api.conversations, template: "teams" in api };
    });
    expect(publicApi).toEqual({ workspaces: false, projects: false, setProject: false, template: false });
    const snapshot = await page.evaluate(async ({ botId, sessionId }) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.capabilities.getSnapshot({ botId, sessionId }), { botId: fixture.bot.id, sessionId: fixture.first.session.id });
    expect(snapshot.ok).toBe(true);
    if (snapshot.ok) {
      expect(snapshot.data.capabilities.some(item => item.id.startsWith("workspace."))).toBe(false);
      expect(snapshot.data.permissions.some(item => item.id.startsWith("workspace."))).toBe(false);
      expect(snapshot.data.availableTools.some(name => name.startsWith("workspace_"))).toBe(false);
    }
    for (const width of [1440, 1020, 620, 390]) {
      await application.evaluate(({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0]?.setContentSize(nextWidth, 844), width);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1440, 900));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1440);
    await page.screenshot({ path: testInfo.outputPath("without-workspace.png") });
    expect(errors).toEqual([]);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
    await closeTestApplicationWithExit(application);
    application = undefined;
    assertLegacyData(fixture);
  } finally {
    if (application) await closeTestApplicationWithExit(application);
    removeTestDirectory(fixture.directory);
  }
});

test("new Bots and Rooms do not inherit legacy directory grants and remain reachable after restart", async () => {
  test.setTimeout(60_000);
  const fixture = await legacyData();
  let application: ElectronApplication | undefined;
  try {
    application = await launch(fixture);
    const page = await application.firstWindow();
    await expect(page.locator(".app-shell")).toBeVisible();
    const result = await page.evaluate(async legacyBotId => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const created = await api.bots.create();
      if (!created.ok) throw new Error(created.error.code);
      const updated = await api.bots.update({ id: created.data.bot.id, expectedVersion: created.data.bot.version, patch: { name: "无目录新成员" } });
      if (!updated.ok) throw new Error(updated.error.code);
      const room = await api.rooms.create({ name: "无目录新群聊", memberBotIds: [legacyBotId, created.data.bot.id], leadBotId: null });
      if (!room.ok) throw new Error(room.error.code);
      const conversations = await api.conversations.list();
      if (!conversations.ok) throw new Error(conversations.error.code);
      return { bot: created.data.bot, room: room.data.room, conversations: conversations.data };
    }, fixture.bot.id);
    expect(result.conversations.find(item => item.botId === result.bot.id)).toMatchObject({ projectId: null, workspaceIds: [] });
    expect(result.conversations.find(item => item.roomId === result.room.id)).toMatchObject({ projectId: null, workspaceIds: [] });
    await closeTestApplicationWithExit(application);
    application = await launch(fixture);
    const restarted = await application.firstWindow();
    await expect(restarted.locator(".app-shell")).toBeVisible();
    await selectNavigationTab(restarted, "联系人");
    await expect(restarted.getByRole("listitem", { name: "无目录新成员", exact: true })).toBeVisible();
    await expect(restarted.getByRole("listitem", { name: fixture.bot.name, exact: true })).toBeVisible();
    await selectNavigationTab(restarted, "聊天");
    await expect(restarted.getByRole("listitem", { name: "无目录新群聊", exact: true })).toBeVisible();
    await expect(restarted.getByRole("tab", { name: "工作区", exact: true, includeHidden: true })).toHaveCount(0);
    await closeTestApplicationWithExit(application);
    application = undefined;
    assertLegacyData(fixture);
  } finally {
    if (application) await closeTestApplicationWithExit(application);
    removeTestDirectory(fixture.directory);
  }
});
