import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import type { HostComputerStatus } from "../../src/shared/host-computer-contracts";
import type { HostComputerTarget } from "../../src/shared/host-computer-targets";
import type { ComputerTask } from "../../src/shared/computer-task-contracts";
import { AppRepository } from "../../src/main/database";
import { openBuiltinBrowserTools, openInspector, openSettingsFromAccount, selectDetailsTab, selectNavigationTab } from "./navigation";
import { closeTestApplicationWithExit, removeTestDirectory } from "./test-cleanup";
import { captureElectron } from "./electron-screenshot";
import { observeTestClose } from "./close-observation";

type TargetUiState = {
  status: HostComputerStatus; holdStatus: boolean; statusReplies: Array<() => void>; starts: number;
  targets: HostComputerTarget[]; holdTargets: boolean; targetReplies: Array<() => void>; saveConflict: boolean; controls: number; previews: number; extensionOpens: number;
  browserScopes: Array<{ sessionId: string; executorBotId: string }>;
  taskReplies: Array<() => void>; cancelReplies: Array<() => void>;
};
type TargetUiFixture = { app: ElectronApplication; page: Page; bots: Array<{ id: string; sessionId: string; name: string }>; room: { name: string; sessionId: string } };
async function withTargetUi(callback: (fixture: TargetUiFixture) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-computer-target-ui-")), repository = new AppRepository(join(directory, "aevoren-bot.sqlite"));
  const bots = ["目标验收 A", "目标验收 B"].map(name => { const created = repository.createBot(); repository.updateBot(created.bot.id, created.bot.version, { name }); return { id: created.bot.id, sessionId: created.session.id, name }; });
  const room = repository.createRoom({ name: "目标验收群", memberBotIds: bots.map(bot => bot.id), leadBotId: null }); repository.close();
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: { ...process.env, AEVOREN_BOT_USER_DATA_DIR: directory, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_FAKE_PROVIDER: "1" } });
  try {
    const page = await app.firstWindow(); await expect(page.locator(".app-shell")).toBeVisible();
    await app.evaluate(({ ipcMain }) => {
      const state: TargetUiState = { status: { configuration: { version: 1, target: "builtin", enabled: true, hostTarget: null }, supported: true, helperAvailable: true, screenPermission: "granted", accessibility: true, browserConnected: true, owner: "user", epoch: 1, busy: false }, holdStatus: false, statusReplies: [], starts: 0, browserScopes: [], taskReplies: [], cancelReplies: [], targets: [{ kind: "app", pid: 111, startedAt: 1000, windowId: 222, appName: "后台验收应用", title: "后台验收窗口" }, { kind: "browser", connectionId: "fixture-browser", tabId: 333, title: "共享验收标签页", url: "https://example.test/shared" }], holdTargets: false, targetReplies: [], saveConflict: false, controls: 0, previews: 0, extensionOpens: 0 };
      Object.assign(globalThis, { targetUiState: state });
      ipcMain.removeHandler("hostComputer:status"); ipcMain.handle("hostComputer:status", () => state.holdStatus ? new Promise(resolve => { state.statusReplies.push(() => resolve({ ok: true, data: state.status })); }) : { ok: true, data: state.status });
      ipcMain.removeHandler("hostComputer:save"); ipcMain.handle("hostComputer:save", (_event, configuration) => {
        if (state.saveConflict) { state.saveConflict = false; state.status.configuration.version++; return { ok: false, error: { code: "COMPUTER_TASK_CONFLICT", safeMessage: "设置已更新，当前选择已保留，请再次保存。" } }; }
        state.status = { ...state.status, configuration: { ...configuration, version: state.status.configuration.version + 1 } }; return { ok: true, data: state.status };
      });
      ipcMain.removeHandler("hostComputer:targets"); ipcMain.handle("hostComputer:targets", () => state.holdTargets ? new Promise(resolve => { state.targetReplies.push(() => resolve({ ok: true, data: state.targets })); }) : { ok: true, data: state.targets });
      ipcMain.removeHandler("hostComputer:control"); ipcMain.handle("hostComputer:control", (_event, input) => { state.controls++; state.status = { ...state.status, owner: input.owner, epoch: state.status.epoch + 1 }; return { ok: true, data: state.status }; });
      ipcMain.removeHandler("hostComputer:preview"); ipcMain.handle("hostComputer:preview", () => { state.previews++; return { ok: true, data: { dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", capturedAt: new Date().toISOString() } }; });
      ipcMain.removeHandler("hostComputer:pairBrowser"); ipcMain.handle("hostComputer:pairBrowser", () => { state.status.browserConnected = false; state.targets = state.targets.filter(target => target.kind !== "browser"); return { ok: true, data: { endpoint: "ws://127.0.0.1:4321", code: "TEST-ONLY", expiresAt: "2099-01-01T00:00:00.000Z" } }; });
      ipcMain.removeHandler("hostComputer:revokeBrowser"); ipcMain.handle("hostComputer:revokeBrowser", () => { state.status.browserConnected = false; state.targets = state.targets.filter(target => target.kind !== "browser"); return { ok: true, data: undefined }; });
      ipcMain.removeHandler("hostComputer:openBrowserExtension"); ipcMain.handle("hostComputer:openBrowserExtension", () => { state.extensionOpens++; return { ok: true, data: undefined }; });
      ipcMain.removeHandler("browser:get"); ipcMain.handle("browser:get", (_event, scope) => { state.browserScopes.push(scope); return { ok: true, data: null }; });
      for (const channel of ["computer:view", "computer:startupStatus"]) { ipcMain.removeHandler(channel); ipcMain.handle(channel, () => ({ ok: true, data: null })); }
      ipcMain.removeHandler("browser:start"); ipcMain.handle("browser:start", () => { state.starts++; return { ok: false, error: { code: "BROWSER_UNAVAILABLE", safeMessage: "Fixture blocks actual Docker startup" } }; });
    });
    await callback({ app, page, bots, room: { name: room.room.name, sessionId: room.session.id } });
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
  } finally {
    await app.evaluate(() => { const state = (globalThis as unknown as { targetUiState?: TargetUiState }).targetUiState; if (state) for (const replies of [state.statusReplies, state.targetReplies, state.taskReplies, state.cancelReplies]) replies.splice(0).forEach(reply => reply()); });
    await closeTestApplicationWithExit(app); removeTestDirectory(directory);
  }
}

test("reopening Computer waits for the newly selected target before mounting a backend", async () => {
  await withTargetUi(async ({ app, page, bots }) => {
    await page.locator(".sidebar").getByRole("listitem", { name: bots[0]!.name, exact: true }).click(); await openInspector(page);
    const contact = page.getByRole("main", { name: "联系人资料", exact: true });
    await selectDetailsTab(contact, "电脑"); await expect(contact).toContainText("Fixture blocks actual Docker startup");
    await openSettingsFromAccount(page); const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "电脑", exact: true }).click();
    await settings.getByLabel("默认电脑", { exact: true }).selectOption("mac");
    await expect(settings.getByLabel("默认电脑", { exact: true })).toHaveValue("mac");
    await app.evaluate(() => { const state = (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState; state.starts = 0; state.holdStatus = true; });
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState.statusReplies.length)).toBeGreaterThan(0);
    await expect(contact).toContainText("正在读取电脑设置");
    expect(await app.evaluate(() => (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState.starts)).toBe(0);
    await app.evaluate(() => { const state = (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState; state.holdStatus = false; state.statusReplies.splice(0).forEach(reply => reply()); });
    await expect(contact.getByRole("heading", { name: "这台 Mac", exact: true })).toBeVisible();
    expect(await app.evaluate(() => (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState.starts)).toBe(0);
  });
});

test("Computer settings use the visible contact scope instead of the previous chat", async () => {
  await withTargetUi(async ({ app, page, bots }) => {
    await page.locator(".sidebar").getByRole("listitem", { name: bots[0]!.name, exact: true }).click();
    await selectNavigationTab(page, "联系人");
    await page.locator(".sidebar").getByRole("listitem", { name: bots[1]!.name, exact: true }).click();
    const contact = page.getByRole("main", { name: "联系人资料", exact: true }); await expect(contact).toContainText(bots[1]!.name);
    const panel = await openBuiltinBrowserTools(page);
    await expect(panel.locator(".computer-scope-note")).toContainText(bots[1]!.name);
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState.browserScopes.at(-1))).toEqual({ sessionId: bots[1]!.sessionId, executorBotId: bots[1]!.id });
  });
});

test("Mac member changes discard the previous task and delayed action receipts", async () => {
  await withTargetUi(async ({ app, page, bots, room }) => {
    await app.evaluate(({ ipcMain }, { bots, sessionId }) => {
      const state = (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState; state.status.configuration.target = "mac";
      const tasks: ComputerTask[] = bots.map(bot => ({ id: `task-${bot.id}`, sessionId, executorBotId: bot.id, target: "mac", parentRunId: null, goal: `TASK_FOR_${bot.name}`, state: "running", version: 1, modelSelection: { providerInstanceId: "fixture", modelId: "fixture" }, providerVersion: 1, segment: 1, actionCount: 0, result: null, errorCode: null, createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z" }));
      ipcMain.removeHandler("computerTasks:list"); ipcMain.handle("computerTasks:list", (_event, scope) => {
        const task = tasks.find(task => task.executorBotId === scope.executorBotId);
        return scope.executorBotId === bots[1]!.id ? new Promise(resolve => { state.taskReplies.push(() => resolve({ ok: true, data: [task] })); }) : { ok: true, data: [task] };
      });
      ipcMain.removeHandler("computerTasks:cancel"); ipcMain.handle("computerTasks:cancel", () => new Promise(resolve => { state.cancelReplies.push(() => resolve({ ok: true, data: { ...tasks[0]!, state: "cancelled" } })); }));
    }, { bots, sessionId: room.sessionId });
    await page.locator(".sidebar").getByRole("listitem", { name: room.name, exact: true }).click(); await openInspector(page);
    const inspector = page.getByRole("dialog", { name: "群聊设置", exact: true }); await selectDetailsTab(inspector, "电脑");
    await expect(inspector).toContainText(`TASK_FOR_${bots[0]!.name}`);
    await inspector.getByRole("button", { name: "停止任务", exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState.cancelReplies.length)).toBe(1);
    await inspector.getByLabel("电脑成员", { exact: true }).selectOption(bots[1]!.id);
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState.taskReplies.length)).toBe(1);
    await expect(inspector).not.toContainText(`TASK_FOR_${bots[0]!.name}`);
    await app.evaluate(() => (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState.taskReplies.splice(0).forEach(reply => reply()));
    await expect(inspector).toContainText(`TASK_FOR_${bots[1]!.name}`);
    await app.evaluate(() => (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState.cancelReplies.splice(0).forEach(reply => reply()));
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(inspector).toContainText(`TASK_FOR_${bots[1]!.name}`);
    await expect(inspector).not.toContainText(`TASK_FOR_${bots[0]!.name}`);
    await expect(inspector.getByRole("button", { name: "停止任务", exact: true })).toBeEnabled();
  });
});

test("Mac controls wait for the selected background window and disable when it disappears", async () => {
  await withTargetUi(async ({ app, page, bots }) => {
    await app.evaluate(() => { const state = (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState; state.status.configuration.target = "mac"; state.status.configuration.hostTarget = state.targets[0]!; state.holdTargets = true; });
    await page.locator(".sidebar").getByRole("listitem", { name: bots[0]!.name, exact: true }).click(); await openInspector(page);
    const contact = page.getByRole("main", { name: "联系人资料", exact: true }); await selectDetailsTab(contact, "电脑");
    const panel = contact.getByRole("region", { name: "电脑", exact: true });
    await expect(panel).toContainText("后台验收应用 · 后台验收窗口");
    await expect(panel).toContainText("正在检查目标");
    await expect(panel.getByRole("button", { name: "交给 AI", exact: true })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "查看画面", exact: true })).toBeDisabled();
    expect(await app.evaluate(() => (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState.controls)).toBe(0);
    await app.evaluate(() => { const state = (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState; state.holdTargets = false; state.targetReplies.splice(0).forEach(reply => reply()); });
    await expect(panel.getByRole("button", { name: "交给 AI", exact: true })).toBeEnabled();
    await app.evaluate(() => { (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState.targets = []; });
    await expect(panel.getByRole("button", { name: "交给 AI", exact: true })).toBeDisabled();
    await expect(panel).toContainText("所选窗口或标签页已不可用");
    await expect(panel).not.toContainText("主屏幕");
  });
});

test("target selection preserves its draft on version conflict and browser pairing stays in settings", async () => {
  await withTargetUi(async ({ app, page }) => {
    await openSettingsFromAccount(page); const settings = page.getByRole("dialog", { name: "设置", exact: true }); await settings.getByRole("button", { name: "电脑", exact: true }).click();
    await expect(settings.getByLabel("本机操作目标", { exact: true })).toBeEnabled();
    await expect(settings.getByLabel("本机操作目标", { exact: true })).toHaveValue("");
    await expect(settings.getByRole("button", { name: "交给 AI", exact: true })).toBeDisabled();
    await settings.getByLabel("本机操作目标", { exact: true }).selectOption("browser:fixture-browser:333");
    await expect(settings.getByRole("button", { name: "交给 AI", exact: true })).toBeDisabled();
    await app.evaluate(() => { (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState.saveConflict = true; });
    await settings.getByRole("button", { name: "保存目标", exact: true }).click();
    await expect(settings.getByRole("alert")).toContainText("当前选择已保留");
    await expect(settings.getByLabel("本机操作目标", { exact: true })).toHaveValue("browser:fixture-browser:333");
    await expect(settings.getByRole("button", { name: "保存目标", exact: true })).toBeEnabled();
    await settings.getByRole("button", { name: "保存目标", exact: true }).click();
    await expect(settings.getByRole("button", { name: "交给 AI", exact: true })).toBeEnabled();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState.status.configuration.hostTarget?.kind)).toBe("browser");
    await settings.getByRole("button", { name: "连接浏览器", exact: true }).click();
    await expect(settings.getByLabel("浏览器配对码", { exact: true })).toHaveValue("TEST-ONLY");
    await expect(settings.getByLabel("浏览器连接地址", { exact: true })).toHaveValue("ws://127.0.0.1:4321");
    await expect(settings.getByRole("button", { name: "交给 AI", exact: true })).toBeDisabled();
    expect(await app.evaluate(() => (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState.extensionOpens)).toBe(0);
    await captureElectron(app, test.info().outputPath("background-target-settings.png"), settings);
    await settings.getByRole("button", { name: "撤销浏览器连接", exact: true }).click();
    await expect(settings.getByLabel("浏览器配对码", { exact: true })).toHaveCount(0);
    await expect(settings.getByRole("button", { name: "交给 AI", exact: true })).toBeDisabled();
    await expect(settings).toContainText("暂不可用");
    expect(await app.evaluate(() => (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState.controls)).toBe(0);
  });
});

test("shared browser target needs its connection rather than Mac screen permissions", async () => {
  await withTargetUi(async ({ app, page, bots }) => {
    await app.evaluate(() => { const state = (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState; state.status.configuration.target = "mac"; state.status.configuration.hostTarget = state.targets[1]!; state.status.screenPermission = "denied"; state.status.accessibility = false; state.status.helperAvailable = false; });
    await page.locator(".sidebar").getByRole("listitem", { name: bots[0]!.name, exact: true }).click(); await openInspector(page);
    const contact = page.getByRole("main", { name: "联系人资料", exact: true }); await selectDetailsTab(contact, "电脑");
    const panel = contact.getByRole("region", { name: "电脑", exact: true });
    await expect(panel).toContainText("共享验收标签页");
    await expect(panel.getByRole("button", { name: "交给 AI", exact: true })).toBeEnabled();
    await panel.getByRole("button", { name: "查看画面", exact: true }).click();
    await expect(panel.getByRole("img", { name: "所选目标的画面", exact: true })).toBeVisible();
    expect(await app.evaluate(() => (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState.previews)).toBe(1);
    await app.evaluate(() => { (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState.status.browserConnected = false; });
    await expect(panel.getByRole("button", { name: "交给 AI", exact: true })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "查看画面", exact: true })).toBeDisabled();
    await expect(panel.getByRole("img")).toHaveCount(0);
    await expect(panel).toContainText("浏览器连接已断开");
    await expect(panel).not.toContainText("连接地址");
    await expect(panel).not.toContainText("配对码");
    expect(await app.evaluate(() => (globalThis as unknown as { targetUiState: TargetUiState }).targetUiState.controls)).toBe(0);
  });
});

test("one computer entry, real local permission status, target persistence and no Docker startup for Mac", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-computer-targets-")), repository = new AppRepository(join(directory, "aevoren-bot.sqlite"));
  const created = repository.createBot(); repository.updateBot(created.bot.id, created.bot.version, { name: "电脑位置验收" }); repository.close();
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: { ...process.env, AEVOREN_BOT_USER_DATA_DIR: directory, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_CLOSE_DIAGNOSTICS: "1", AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_FAKE_PROVIDER: "1" } });
  const owned = app.process(), closeObservation = await observeTestClose(app);
  let businessCompleted = false, closedNormally = false;
  const errors: string[] = [];
  try {
    const page = await app.firstWindow(); page.on("pageerror", error => errors.push(error.message));
    await app.evaluate(({ ipcMain }) => { ipcMain.removeHandler("hostComputer:targets"); ipcMain.handle("hostComputer:targets", () => ({ ok: true, data: [] })); });
    await page.locator(".sidebar").getByRole("listitem", { name: "电脑位置验收", exact: true }).click(); await openInspector(page);
    const contact = page.getByRole("main", { name: "联系人资料", exact: true });
    await expect(contact.getByRole("tab", { name: "电脑", exact: true })).toHaveCount(1);
    await expect(contact.getByRole("tab", { name: "电脑工具", exact: true })).toHaveCount(0);
    await openSettingsFromAccount(page); const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "电脑", exact: true }).click();
    await expect(settings.getByRole("heading", { name: "你的电脑", exact: true })).toBeVisible();
    await expect(settings.getByRole("heading", { name: "Bot 的电脑", exact: true })).toBeVisible();
    await expect(settings.getByLabel("默认电脑", { exact: true })).toHaveValue("builtin");
    await expect(settings.getByLabel("允许操作这台 Mac", { exact: true })).not.toBeChecked();
    const status = await page.evaluate(async () => { const result = await (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.hostComputer.status(); if (!result.ok) throw new Error(result.error.code); return result.data; });
    writeFileSync(test.info().outputPath("host-permissions.json"), JSON.stringify(status));
    await test.info().attach("actual-host-permission-status-no-capture-no-input", { body: JSON.stringify(status), contentType: "application/json" });
    expect(status.supported).toBe(process.platform === "darwin");
    await captureElectron(app, test.info().outputPath("computer-settings.png"), settings);
    if (process.platform === "darwin") {
      expect(status.helperAvailable).toBe(true);
      await settings.getByLabel("允许操作这台 Mac", { exact: true }).click();
      await expect(settings.getByLabel("允许操作这台 Mac", { exact: true })).toBeChecked();
      await expect(settings.locator('option[value="mac"]')).toBeEnabled();
      await settings.getByLabel("默认电脑", { exact: true }).selectOption("mac");
      await expect.poll(async () => { const result = await page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.hostComputer.status()); return result.ok ? result.data.configuration.target : "error"; }).toBe("mac");
      await app.evaluate(({ ipcMain }) => {
        const state = globalThis as unknown as { macTargetDockerStarts: number }; state.macTargetDockerStarts = 0;
        ipcMain.removeHandler("browser:start"); ipcMain.handle("browser:start", () => { state.macTargetDockerStarts++; return { ok: false, error: { code: "BROWSER_UNAVAILABLE", safeMessage: "Unexpected Docker startup in Mac routing fixture" } }; });
      });
      await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
      await contact.getByRole("tab", { name: "电脑", exact: true }).click();
      await expect(contact.getByRole("heading", { name: "这台 Mac", exact: true })).toBeVisible();
      await expect(contact.getByRole("button", { name: "交给 AI", exact: true })).toBeVisible();
      await expect(contact.getByRole("button", { name: "启动浏览器与电脑", exact: true })).toHaveCount(0);
      await expect(contact.getByRole("region", { name: "电脑", exact: true }).getByRole("img")).toHaveCount(0); // No unsolicited screen capture or model upload.
      expect(await app.evaluate(() => (globalThis as unknown as { macTargetDockerStarts: number }).macTargetDockerStarts)).toBe(0);
      await expect(contact.getByRole("button", { name: "交给 AI", exact: true })).toBeDisabled();
      await expect(contact.getByRole("button", { name: "查看画面", exact: true })).toBeDisabled();
      await expect(contact).toContainText("尚未选择操作目标");
      await openSettingsFromAccount(page); await settings.getByRole("button", { name: "电脑", exact: true }).click();
      await expect(settings.getByLabel("默认电脑", { exact: true })).toHaveValue("mac");
      await settings.getByLabel("允许操作这台 Mac", { exact: true }).click();
      await expect(settings.getByLabel("允许操作这台 Mac", { exact: true })).not.toBeChecked();
      await expect(settings.getByLabel("默认电脑", { exact: true })).toHaveValue("builtin");
    } else await expect(settings.getByLabel("允许操作这台 Mac", { exact: true })).toBeDisabled();
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
    expect(errors).toEqual([]);
    businessCompleted = true;
  } finally {
    closeObservation.record("close-request");
    try {
      await closeTestApplicationWithExit(app);
      expect({ code: owned.exitCode, signal: owned.signalCode }).toEqual({ code: 0, signal: null });
      closedNormally = true;
    } finally {
      closeObservation.record(closedNormally ? "close-final" : "close-or-exit-failed");
      const path = test.info().outputPath("normal-exit.json");
      const receipt = { code: owned.exitCode, signal: owned.signalCode, errorCount: errors.length, businessCompleted, closedNormally, phases: closeObservation.phases };
      process.stdout.write(`AEVOREN_COMPUTER_TARGET_CLOSE ${JSON.stringify(receipt)}\n`);
      writeFileSync(path, JSON.stringify({ ...receipt, errors }));
      await test.info().attach("computer-target-normal-exit", { path, contentType: "application/json" });
      closeObservation.detach(); removeTestDirectory(directory);
    }
  }
});
