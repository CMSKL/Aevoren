import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { AppRepository } from "../../src/main/database";
import type { AevorenBotApi } from "../../src/shared/contracts";
import type { BrowserScope, ComputerStartup } from "../../src/shared/browser-contracts";
import { selectDetailsTab } from "./navigation";
import { closeTestApplication, removeTestDirectory } from "./test-cleanup";
import { observeTestClose } from "./close-observation";

type StartupFixture = { calls: number; opens: number; startup: ComputerStartup | null; finish(cancelled?: boolean): void };
// Browser plugin not available. Controlled delayed IPC isolates the rendered
// startup/cancel/retry states. Actual Docker acceptance runs separately.
async function withStartup(blocked: boolean, run: (page: Page, application: ElectronApplication) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-computer-startup-"));
  const database = new AppRepository(join(directory, "app.sqlite")); database.setSetting("appearance.theme", "dark", false); database.close();
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("AEVOREN_BOT_FAKE_")));
  const application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ["."]), "--use-mock-keychain"], cwd: process.cwd(),
    env: { ...inherited, AEVOREN_BOT_USER_DATA_DIR: directory, AEVOREN_BOT_DB_PATH: join(directory, "app.sqlite"), AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_CLOSE_DIAGNOSTICS: "1", AEVOREN_BOT_DISABLE_UPDATES: "1" } });
  const probe = await observeTestClose(application), owned = application.process();
  let businessCompleted = false, closedNormally = false;
  try {
    const page = await application.firstWindow(); const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await expect(page).toHaveTitle("Aevoren"); await expect(page.locator(".app-shell")).toBeVisible();
    await page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const result = await api.bots.create(); if (!result.ok) throw new Error(result.error.safeMessage);
      const updated = await api.bots.update({ id: result.data.bot.id, expectedVersion: result.data.bot.version, patch: { name: "启动反馈验收", avatarShape: "rounded", avatarColor: "cobalt" } });
      if (!updated.ok) throw new Error(updated.error.safeMessage);
    });
    await page.reload();
    await application.evaluate(({ ipcMain, BrowserWindow }, initiallyBlocked) => {
      let owner: BrowserScope | undefined, resolvePending: ((value: unknown) => void) | undefined;
      const fixture: StartupFixture = { calls: 0, opens: 0, startup: null, finish(cancelled = false) {
        if (!fixture.startup || !owner) return;
        fixture.startup = { ...fixture.startup, phase: cancelled ? "cancelled" : "error", blocker: cancelled ? null : "startup-failed", message: cancelled ? "电脑启动已取消" : "准备电脑超时，请检查网络后重试。" };
        BrowserWindow.getAllWindows()[0]!.webContents.send("browser:changed", { ...owner, type: "startup", startup: fixture.startup });
        resolvePending?.({ ok: false, error: { code: cancelled ? "TOOL_EXECUTION_CANCELLED" : "BROWSER_UNAVAILABLE", domain: "tool", retryable: true, safeMessage: fixture.startup.message } }); resolvePending = undefined;
      } };
      Object.assign(globalThis, { computerStartupFixture: fixture });
      for (const channel of ["browser:start", "computer:startupStatus", "computer:cancelStartup", "computer:openDocker", "environments:probe"]) ipcMain.removeHandler(channel);
      ipcMain.handle("computer:startupStatus", () => ({ ok: true, data: fixture.startup }));
      ipcMain.handle("browser:start", (_event, input: BrowserScope) => {
        owner = input; fixture.calls++;
        fixture.startup = { attemptId: crypto.randomUUID(), phase: "preparing-browser", message: "正在准备浏览器组件", blocker: null };
        if (initiallyBlocked && fixture.calls === 1) fixture.startup = { ...fixture.startup, phase: "error", message: "Docker 尚未启动", blocker: "docker-stopped" };
        BrowserWindow.getAllWindows()[0]!.webContents.send("browser:changed", { ...owner, type: "startup", startup: fixture.startup });
        if (fixture.startup.phase === "error") return { ok: false, error: { code: "ENVIRONMENT_UNAVAILABLE", domain: "tool", retryable: true, safeMessage: fixture.startup.message } };
        return new Promise(resolve => { resolvePending = resolve; });
      });
      ipcMain.handle("computer:cancelStartup", () => { fixture.finish(true); return { ok: true, data: fixture.startup }; });
      ipcMain.handle("computer:openDocker", () => { fixture.opens++; return { ok: true, data: undefined }; });
      ipcMain.handle("environments:probe", () => ({ ok: true, data: { available: fixture.opens > 0, dockerInstalled: true, daemonReachable: fixture.opens > 0 } }));
    }, blocked);
    await page.locator(".sidebar").getByRole("listitem", { name: "启动反馈验收", exact: true }).click();
    await page.getByRole("button", { name: "查看对话详情", exact: true }).click();
    await selectDetailsTab(page.getByRole("main", { name: "联系人资料", exact: true }), "电脑");
    await run(page, application);
    expect(errors).toEqual([]);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
    businessCompleted = true;
  } finally {
    await application.evaluate(() => (globalThis as unknown as { computerStartupFixture?: StartupFixture }).computerStartupFixture?.finish(true));
    probe.record("close-request");
    try {
      await closeTestApplication(application);
      expect({ code: owned.exitCode, signal: owned.signalCode }).toEqual({ code: 0, signal: null });
      closedNormally = true;
    } finally {
      probe.record(closedNormally ? "close-final" : "close-or-exit-failed");
      const path = test.info().outputPath("computer-close-phases.json");
      writeFileSync(path, JSON.stringify({ businessCompleted, closedNormally, phases: probe.phases }));
      await test.info().attach("computer-close-phases", { path, contentType: "application/json" });
      probe.detach(); removeTestDirectory(directory);
    }
  }
}

test("opening the computer prepares once, survives tab changes, cancels and offers an explicit retry", async () => {
  // Windows traces spend ~2s on each trusted pointer action. This UI lifecycle
  // budget is independent of the bounded normal-close acceptance below.
  test.setTimeout(process.platform === "win32" ? 60_000 : 30_000);
  await withStartup(false, async (page, application) => {
    const contact = page.getByRole("main", { name: "联系人资料", exact: true });
    const panel = contact.getByRole("region", { name: "电脑", exact: true });
    await expect(panel.getByRole("heading", { name: "正在准备电脑", exact: true })).toBeVisible();
    await expect(panel.getByText("正在准备浏览器组件", { exact: true })).toBeVisible();
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(panel.getByRole("button", { name: "启动浏览器与电脑", exact: true })).toHaveCount(0);
    await expect(panel.getByText("示范技能", { exact: true })).toHaveCount(0);
    await selectDetailsTab(contact, "详情"); await selectDetailsTab(contact, "电脑");
    expect(await application.evaluate(() => (globalThis as unknown as { computerStartupFixture: StartupFixture }).computerStartupFixture.calls)).toBe(1);
    await expect(panel.getByText("正在准备浏览器组件", { exact: true })).toBeVisible();
    if (process.env.AEVOREN_STARTUP_SCREENSHOT) await page.screenshot({ path: process.env.AEVOREN_STARTUP_SCREENSHOT });
    await panel.getByRole("button", { name: "取消启动", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "电脑已停止", exact: true })).toBeVisible();
    expect(await application.evaluate(() => (globalThis as unknown as { computerStartupFixture: StartupFixture }).computerStartupFixture.calls)).toBe(1);
    await panel.getByRole("button", { name: "启动电脑", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "正在准备电脑", exact: true })).toBeVisible();
    await application.evaluate(() => (globalThis as unknown as { computerStartupFixture: StartupFixture }).computerStartupFixture.finish());
    await expect(panel.getByRole("heading", { name: "准备电脑超时，请检查网络后重试。", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "重试", exact: true })).toBeVisible();
  });
});

test("a stopped Docker engine has one action and resumes preparation when ready", async () => {
  test.setTimeout(process.platform === "win32" ? 60_000 : 30_000);
  await withStartup(true, async (page, application) => {
    const panel = page.getByRole("region", { name: "电脑", exact: true });
    await expect(panel.getByRole("heading", { name: "Docker 尚未启动", exact: true })).toBeVisible();
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    if (process.env.AEVOREN_BLOCKED_SCREENSHOT) await page.screenshot({ path: process.env.AEVOREN_BLOCKED_SCREENSHOT });
    await panel.getByRole("button", { name: "启动 Docker", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "正在准备电脑", exact: true })).toBeVisible();
    expect(await application.evaluate(() => {
      const f = (globalThis as unknown as { computerStartupFixture: StartupFixture }).computerStartupFixture; return { opens: f.opens, calls: f.calls };
    })).toEqual({ opens: 1, calls: 2 });
  });
});

test("a stopped human-owned computer offers one explicit return-and-prepare action", async () => {
  await withStartup(false, async (page, application) => {
    await expect.poll(() => application.evaluate(() => (globalThis as unknown as { computerStartupFixture: StartupFixture }).computerStartupFixture.calls)).toBe(1);
    await application.evaluate(({ ipcMain }) => {
      const state = { returns: 0 }, browserSessionId = crypto.randomUUID();
      const view = (scope: BrowserScope) => ({ ...scope, browserSessionId, owner: state.returns ? "ai" : "user", epoch: state.returns ? 8 : 6,
        version: state.returns ? 3 : 2, connectionState: "disconnected", observedEpoch: null, updatedAt: new Date().toISOString() });
      for (const channel of ["browser:get", "computer:view", "computer:returnControl"]) ipcMain.removeHandler(channel);
      ipcMain.handle("browser:get", (_event, scope: BrowserScope) => ({ ok: true, data: { ...scope, id: browserSessionId, environmentId: crypto.randomUUID(), state: "stopped", version: 2, controlEpoch: 6, activePageId: null, bootId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }));
      ipcMain.handle("computer:view", (_event, scope: BrowserScope) => ({ ok: true, data: view(scope) }));
      ipcMain.handle("computer:returnControl", (_event, scope: BrowserScope & { expectedEpoch: number }) => {
        if (scope.expectedEpoch !== 6) throw new Error("stale recovery epoch");
        state.returns++; return { ok: true, data: view(scope) };
      });
      Object.assign(globalThis, { computerRecoveryFixture: state });
      (globalThis as unknown as { computerStartupFixture: StartupFixture }).computerStartupFixture.finish();
    });
    const panel = page.getByRole("main", { name: "联系人资料", exact: true }).getByRole("region", { name: "电脑", exact: true });
    await expect(panel.getByRole("heading", { name: "电脑已停止，等待归还控制", exact: true })).toBeVisible();
    await expect(panel.getByText("上次接管状态仍保留。归还后将自动准备电脑，并保留原工作目录。", { exact: true })).toBeVisible();
    expect(await application.evaluate(() => (globalThis as unknown as { computerRecoveryFixture: { returns: number } }).computerRecoveryFixture.returns)).toBe(0);
    await panel.getByRole("button", { name: "归还控制并准备电脑", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "正在准备电脑", exact: true })).toBeVisible();
    expect(await application.evaluate(() => ({ calls: (globalThis as unknown as { computerStartupFixture: StartupFixture }).computerStartupFixture.calls,
      returns: (globalThis as unknown as { computerRecoveryFixture: { returns: number } }).computerRecoveryFixture.returns }))).toEqual({ calls: 2, returns: 1 });
  });
});

test("a successful return clears an earlier read failure without hiding a new operation failure", async () => {
  await withStartup(false, async (page, application) => {
    await expect.poll(() => application.evaluate(() => (globalThis as unknown as { computerStartupFixture: StartupFixture }).computerStartupFixture.calls)).toBe(1);
    await application.evaluate(({ ipcMain }) => {
      const browserSessionId = crypto.randomUUID(), environmentId = crypto.randomUUID();
      let epoch = 11, owner = "user", returnReply: (() => void) | undefined;
      const reads: Array<(value: unknown) => void> = [];
      const view = (scope: BrowserScope) => ({ ...scope, browserSessionId, owner, epoch, version: epoch, connectionState: "disconnected", observedEpoch: null, updatedAt: new Date().toISOString() });
      const failure = (message: string) => ({ ok: false, error: { code: "COMPUTER_CONTROL_CHANGED", domain: "tool", retryable: true, safeMessage: message } });
      for (const channel of ["browser:get", "browser:tabs", "browser:downloads", "preview:list", "computer:view", "computer:returnControl", "computer:vncTicket", "computer:screenshot", "computer:takeover"]) ipcMain.removeHandler(channel);
      ipcMain.handle("browser:get", (_event, scope: BrowserScope) => ({ ok: true, data: { ...scope, id: browserSessionId, environmentId, state: "running", version: epoch, controlEpoch: epoch, activePageId: null, bootId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }));
      ipcMain.handle("computer:view", (_event, scope: BrowserScope) => ({ ok: true, data: view(scope) }));
      ipcMain.handle("browser:tabs", (_event, input: { expectedEpoch: number }) => input.expectedEpoch === 11 ? new Promise(resolve => reads.push(resolve)) : { ok: true, data: [] });
      ipcMain.handle("browser:downloads", () => ({ ok: true, data: { items: [], errors: [] } }));
      ipcMain.handle("preview:list", () => ({ ok: true, data: [] }));
      ipcMain.handle("computer:vncTicket", () => failure("受控测试不连接 VNC"));
      ipcMain.handle("computer:returnControl", (_event, scope: BrowserScope & { expectedEpoch: number }) => {
        if (scope.expectedEpoch !== 11) throw new Error("stale fixture epoch");
        return new Promise(resolve => { returnReply = () => { epoch = 12; owner = "ai"; resolve({ ok: true, data: view(scope) }); }; });
      });
      ipcMain.handle("computer:screenshot", (_event, scope: BrowserScope) => ({ ok: true, data: { frame: { browserSessionId, controlEpoch: epoch, dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6iFAAAAAASUVORK5CYII=", mimeType: "image/png", width: 1, height: 1, capturedAt: new Date().toISOString() }, media: { ...scope } } }));
      ipcMain.handle("computer:takeover", () => failure("新的接管失败必须保留"));
      Object.assign(globalThis, { computerReturnReadFixture: {
        failReads() { for (const resolve of reads.splice(0)) resolve(failure("旧读取：电脑控制权已变化")); },
        finishReturn() { returnReply?.(); },
        get pendingReturn() { return Boolean(returnReply); },
      } });
      (globalThis as unknown as { computerStartupFixture: StartupFixture }).computerStartupFixture.finish();
    });
    const panel = page.getByRole("main", { name: "联系人资料", exact: true }).getByRole("region", { name: "电脑", exact: true });
    await panel.getByRole("button", { name: "交给 AI", exact: true }).click();
    await expect.poll(() => application.evaluate(() => (globalThis as unknown as { computerReturnReadFixture: { pendingReturn: boolean } }).computerReturnReadFixture.pendingReturn)).toBe(true);
    await application.evaluate(() => (globalThis as unknown as { computerReturnReadFixture: { failReads(): void } }).computerReturnReadFixture.failReads());
    await expect(panel.getByText("旧读取：电脑控制权已变化", { exact: true })).toBeVisible();
    await application.evaluate(() => (globalThis as unknown as { computerReturnReadFixture: { finishReturn(): void } }).computerReturnReadFixture.finishReturn());
    await expect(panel.getByText("AI 可操作", { exact: true })).toBeVisible();
    await expect(panel.getByText("已交给 AI。", { exact: true })).toBeVisible();
    await expect(panel.getByText("旧读取：电脑控制权已变化", { exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "我来操作", exact: true }).click();
    await expect(panel.getByText("新的接管失败必须保留", { exact: true })).toBeVisible();
  });
});
