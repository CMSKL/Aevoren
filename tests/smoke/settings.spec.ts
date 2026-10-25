import { captureElectron } from "./electron-screenshot";
import { closeTestApplicationWithExit, removeTestDirectory } from "./test-cleanup";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron, expect, test } from "@playwright/test";
import { openSettingsFromAccount, openInspector } from "./navigation";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { IPC } from "../../src/shared/channels";

const appVersion = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

test("opens settings from the account menu and preserves general and model configuration", async () => {
  // Windows traces show ~2s per trusted pointer action; this multi-step flow
  // has its own UI budget. Native shutdown still has the original strict 3s bound.
  test.setTimeout(process.platform === "win32" ? 120_000 : 30_000);
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-bot-settings-"));
  const environment = {
    ...process.env,
    AEVOREN_BOT_USER_DATA_DIR: userDataDir,
    AEVOREN_BOT_FAKE_PROVIDER: "1",
    AEVOREN_BOT_DISABLE_UPDATES: "1",
  };

  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  let application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: environment });
  try {
    if (executablePath) expect(await application.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }))).toEqual({ packaged: true, version: appVersion });
    let page = await application.firstWindow();
    const consoleErrors: string[] = [];
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1182, 804));
    await page.getByRole("button", { name: "新建聊天", exact: true }).click();
    await page.getByRole("button", { name: "创建新 Bot", exact: true }).click();
    await expect(page.getByRole("main", { name: "联系人资料", exact: true })).toBeVisible();
    await expect(page.locator(".sidebar-footer > button")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "打开账户菜单", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "设置", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "连接应用", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "模型设置" })).toHaveCount(0);
    await captureElectron(application, "/tmp/aevoren-sidebar-avatar-only.png", page.locator(".sidebar"));

    await openSettingsFromAccount(page);
    await expect(page.getByRole("dialog", { name: "设置", exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "界面主题", exact: true }).selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByLabel("自动批准公开只读工具")).toBeChecked();
    await page.getByLabel("自动批准公开只读工具").click();
    await expect(page.getByLabel("自动批准公开只读工具")).not.toBeChecked();
    await page.getByLabel("自动批准公开只读工具").click();
    await expect(page.getByLabel("自动批准公开只读工具")).toBeChecked();
    if (executablePath && process.platform === "darwin") {
      await expect(page.getByLabel("登录时启动")).toBeEnabled();
      await expect(page.getByText("当前运行环境不支持登录时启动", { exact: true })).toHaveCount(0);
    } else {
      await expect(page.getByLabel("登录时启动")).toBeDisabled();
      await expect(page.getByText("当前运行环境不支持登录时启动", { exact: true })).toBeVisible();
    }
    await captureElectron(application, "/tmp/aevoren-settings-general-1182x804.png");
    await captureElectron(application, "/tmp/aevoren-settings-general-modal.png", page.locator(".settings-dialog"));

    await page.getByRole("button", { name: "能力与权限", exact: true }).click();
    await expect(page.getByRole("heading", { name: "能力与权限", exact: true })).toBeVisible();
    await expect(page.locator('[data-capability="conversation.text"]')).toContainText("可用");
    await expect(page.locator('[data-capability^="workspace."]')).toHaveCount(0);
    await expect(page.locator('[data-capability="network.search"]')).toContainText("可用");
    await expect(page.getByText("仅前台运行", { exact: false })).toBeVisible();
    await captureElectron(application, "/tmp/aevoren-settings-capabilities-modal.png", page.locator(".settings-dialog"));

    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await openInspector(page, "models");
    await page.getByRole("button", { name: "管理模型连接", exact: true }).click();
    await expect(page.getByRole("region", { name: "模型设置", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "需要设置", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "重新扫描", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "管理 Codex CLI", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "管理 Claude Code", exact: true })).toBeVisible();
    await expect(page.locator(".provider-settings-card").filter({ hasText: "API" })).toBeVisible();
    await expect(page.locator(".provider-engine-card")).toHaveCount(3);
    await expect(page.getByText("Ollama", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Gemini CLI", { exact: true })).toHaveCount(0);
    await expect(page.locator('.provider-engine-card[data-provider-state="unconfigured"]')).toHaveCount(1);
    await expect(page.locator(".provider-engine-card .provider-status-pill").filter({ hasText: /未安装|未登录|不可用/u }).first()).toBeVisible();
    await expect(page.getByLabel("Codex CLI 手动 CLI 路径")).toBeHidden();
    await captureElectron(application, "/tmp/aevoren-settings-model-1182x804.png");
    await captureElectron(application, "/tmp/aevoren-settings-model-contact.png", page.locator(".settings-dialog"));
    await page.getByLabel("管理 API").click();
    await page.getByLabel("Base URL").fill("https://example.com/v1/");
    await page.getByLabel("API Key").fill("settings-smoke-secret");
    // A concurrent save advances the real configuration version; the user's
    // pending input must survive the conflict without overwriting that version.
    await page.evaluate(async () => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const result = await api.providers.list();
      if (!result.ok) throw new Error(result.error.code);
      const provider = result.data.find(item => item.driverKind === "openai-compatible")!;
      const saved = await api.providers.saveOpenAiCompatible({ instanceId: provider.id, expectedVersion: provider.version, baseUrl: provider.baseUrl! });
      if (!saved.ok) throw new Error(saved.error.code);
    });
    await page.getByRole("button", { name: "保存 API 配置", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("配置已变化");
    await expect(page.getByLabel("Base URL")).toHaveValue("https://example.com/v1/");
    await expect(page.getByLabel("API Key")).toHaveValue("settings-smoke-secret");
    await page.getByRole("button", { name: "放弃修改", exact: true }).click();
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await page.getByRole("button", { name: "管理模型连接", exact: true }).click();
    await page.getByLabel("管理 API").click();
    await page.getByLabel("Base URL").fill("https://example.com/v1/");
    await page.getByLabel("API Key").fill("settings-smoke-secret");
    await page.getByRole("button", { name: "保存 API 配置", exact: true }).click();
    await expect(page.getByText("API 配置已保存。")).toBeVisible();
    await expect(page.getByRole("heading", { name: "已就绪", exact: true })).toBeVisible();
    await expect(page.locator('.provider-engine-card[data-provider-state="ready"]').filter({ hasText: "API" })).toBeVisible();
    // Only delay the test transport to verify the pending-operation navigation
    // guard. This is not evidence of a real third-party connection test.
    await application.evaluate(({ ipcMain }, channel) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, () => new Promise(resolve => {
        Object.assign(globalThis, { finishModelConnectionTest: () => resolve({ ok: true, data: undefined }) });
      }));
    }, IPC.providersTest);
    await page.locator(".provider-settings-card").filter({ hasText: "API" }).getByRole("button", { name: "测试真实请求", exact: true }).click();
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "设置", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("正在处理");
    await application.evaluate(() => (globalThis as unknown as { finishModelConnectionTest(): void }).finishModelConnectionTest());
    await expect(page.getByText("API 已完成真实最小请求。", { exact: true })).toBeVisible();
    const codexCard = page.locator(".provider-settings-card").filter({ hasText: "Codex CLI" });
    await codexCard.getByLabel("管理 Codex CLI").click();
    await codexCard.getByText("高级：手动指定 CLI 路径", { exact: true }).click();
    await expect(page.getByLabel("Codex CLI 手动 CLI 路径")).toHaveValue("codex");

    await page.getByRole("button", { name: "MCP", exact: true }).click();
    await expect(page.getByText("尚未配置 MCP Server。", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "添加网页搜索", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "添加网页搜索", exact: true }).click();
    const searchCard = page.locator('[data-mcp-server="exa-search"]');
    await expect(searchCard).toContainText("https://mcp.exa.ai/mcp");
    await expect(searchCard).toContainText("OAuth 未授权");
    await expect(searchCard.getByRole("button", { name: "OAuth 授权" })).toBeVisible();
    await page.getByRole("button", { name: "添加 Server", exact: true }).click();
    await page.getByLabel("MCP 名称").fill("settings-fixture");
    await page.getByLabel("MCP URL").fill("https://example.com/mcp");
    await page.getByLabel("MCP Headers").fill("Authorization: Bearer mcp-settings-secret");
    await page.getByRole("button", { name: "保存（默认关闭）", exact: true }).click();
    const mcpCard = page.locator('[data-mcp-server="settings-fixture"]');
    await expect(mcpCard).toContainText("未启用");
    await expect(mcpCard).toContainText("1 个 Secret");
    await expect(page.getByText("mcp-settings-secret", { exact: false })).toHaveCount(0);

    await page.getByRole("button", { name: "长期记忆", exact: true }).click();
    await expect(page.getByLabel("后台生成 Memory 候选")).toBeChecked();
    await page.getByLabel("后台生成 Memory 候选").uncheck();
    await page.getByLabel("新增范围 Memory").fill("所有 Bot 都使用简洁中文回答");
    await page.getByRole("button", { name: "添加 Memory", exact: true }).click();
    await expect(page.locator('textarea[aria-label^="Memory "]').first()).toHaveValue("所有 Bot 都使用简洁中文回答");

    await page.getByRole("button", { name: "版本更新", exact: true }).click();
    await captureElectron(application, "/tmp/aevoren-settings-update-1182x804.png");
    await captureElectron(application, "/tmp/aevoren-settings-update-modal.png", page.locator(".settings-dialog"));
    await expect(page.getByLabel("自动检查更新频率")).toHaveValue("360");
    await page.getByLabel("自动检查更新频率").selectOption("720");
    await expect(page.getByLabel("自动检查更新频率")).toHaveValue("720");
    await expect(page.locator('[aria-labelledby="settings-update-title"]').getByText(`v${appVersion}`, { exact: true })).toBeVisible();
    await expect(page.getByText("开发环境未启用", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "检查更新" })).toBeDisabled();
    await page.getByRole("button", { name: "关闭设置" }).click();

    await closeTestApplicationWithExit(application);
    const database = new DatabaseSync(join(userDataDir, "aevoren-bot.sqlite"), { readOnly: true });
    expect(database.prepare("SELECT value, encrypted FROM app_settings WHERE key = 'appearance.theme'").get()).toEqual({
      value: "dark",
      encrypted: 0,
    });
    expect(database.prepare("SELECT value, encrypted FROM app_settings WHERE key = 'tools.autoApprovePublicRead'").get()).toEqual({
      value: "true",
      encrypted: 0,
    });
    expect(database.prepare("SELECT value, encrypted FROM app_settings WHERE key = 'updates.checkIntervalMinutes'").get()).toEqual({ value: "720", encrypted: 0 });
    const storedKey = database.prepare("SELECT value, encrypted FROM app_settings WHERE key = 'provider.openai-compatible.default.apiKey'").get() as { value: string; encrypted: number };
    expect(storedKey.encrypted).toBe(1);
    expect(storedKey.value).not.toContain("settings-smoke-secret");
    const storedMcpSecret = database.prepare("SELECT value, encrypted FROM app_settings WHERE key LIKE 'mcp.server.%.secrets'").get() as { value: string; encrypted: number };
    expect(storedMcpSecret.encrypted).toBe(1);
    expect(storedMcpSecret.value).not.toContain("mcp-settings-secret");
    expect(database.prepare("SELECT scope,scope_key,bot_id,workspace_id,content FROM memory_items WHERE scope = 'user'").get()).toEqual({
      scope: "user",
      scope_key: "user",
      bot_id: null,
      workspace_id: null,
      content: "所有 Bot 都使用简洁中文回答",
    });
    database.close();

    application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: environment });
    page = await application.firstWindow();
    page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await openSettingsFromAccount(page);
    await expect(page.getByRole("combobox", { name: "界面主题", exact: true })).toHaveValue("dark");
    await expect(page.getByLabel("自动批准公开只读工具")).toBeChecked();
    await page.getByRole("button", { name: "版本更新", exact: true }).click();
    await expect(page.getByLabel("自动检查更新频率")).toHaveValue("720");
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await openInspector(page, "models");
    await page.getByRole("button", { name: "管理模型连接", exact: true }).click();
    await expect(page.getByRole("region", { name: "模型设置", exact: true })).toBeVisible();
    await page.getByLabel("管理 API").click();
    await expect(page.getByLabel("Base URL")).toHaveValue("https://example.com/v1");
    await expect(page.getByText("已安全保存；留空表示不替换")).toBeVisible();
    await page.getByRole("button", { name: "MCP", exact: true }).click();
    await expect(page.locator('[data-mcp-server="exa-search"]')).toContainText("OAuth 未授权");
    await expect(page.locator('[data-mcp-server="settings-fixture"]')).toContainText("未启用");
    await page.locator('[data-mcp-server="settings-fixture"]').getByRole("button", { name: "编辑" }).click();
    await expect(page.getByLabel("MCP Headers")).toHaveValue("Authorization: ");
    await page.getByRole("button", { name: "长期记忆", exact: true }).click();
    await expect(page.getByLabel("后台生成 Memory 候选")).not.toBeChecked();
    await expect(page.locator('textarea[aria-label^="Memory "]').first()).toHaveValue("所有 Bot 都使用简洁中文回答");
    expect(consoleErrors).toEqual([]);
  } finally {
    await closeTestApplicationWithExit(application);
    removeTestDirectory(userDataDir);
  }
});
