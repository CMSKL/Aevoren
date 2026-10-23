import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { PRODUCT_VIEW_DOM_EVENT, type ProductViewInput, type ProductViewResult } from "../../src/shared/product-view";
import { AppRepository } from "../../src/main/database";
import { closeTestApplicationWithExit, removeTestDirectory } from "./test-cleanup";

// Browser plugin not available. Hidden Electron validates actual Renderer/IPC state;
// this deterministic HTTP fixture makes no claim of a real model response.
test("runs routine view operations directly and preserves changed drafts", async () => {
  test.setTimeout(120_000);
  const data = mkdtempSync(join(tmpdir(), "aevoren-product-view-"));
  const repository = new AppRepository(join(data, "aevoren-bot.sqlite"));
  const actor = repository.createBot();
  repository.updateBot(actor.bot.id, actor.bot.version, { name: "界面操作验收", modelSelection: { providerInstanceId: "openai-compatible.default", modelId: "fixture-view-model" } });
  repository.setSetting("memory.capture.enabled", "false", false);
  repository.close();
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const command = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
    const user = command.messages.filter((message) => message.role === "user").at(-1)!;
    const input = JSON.parse(user.content.slice(user.content.indexOf("UICASE:") + 7)) as ProductViewInput;
    const tools = command.messages.at(-1)?.role !== "tool";
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = tools ? { tool_calls: [{ index: 0, id: crypto.randomUUID(), type: "function", function: { name: "product_execute", arguments: JSON.stringify({ operation: "view.request", input }) } }] } : { content: "界面请求已处理。" };
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tools ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture server unavailable");
  const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
  const application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : ["."], cwd: process.cwd(), env: { ...process.env, AEVOREN_BOT_FAKE_PROVIDER: "0", AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1" } });
  try {
    const page = await application.firstWindow();
    if (executablePath) expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(true);
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.getByRole("heading", { name: "界面操作验收", exact: true })).toBeVisible();
    await page.evaluate(async (baseUrl) => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const providers = await api.providers.list(); const provider = providers.ok ? providers.data.find((item) => item.id === "openai-compatible.default") : undefined;
      if (!provider) throw new Error("API source unavailable");
      const result = await api.providers.saveOpenAiCompatible({ instanceId: provider.id, expectedVersion: provider.version, baseUrl, apiKey: "view-fixture-token" });
      if (!result.ok) throw new Error(result.error.code);
    }, `http://127.0.0.1:${address.port}/v1`);
    const run = async (input: ProductViewInput) => {
      const sent = await page.evaluate(async ({ sessionId, input }) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.messages.send({ sessionId, clientNonce: crypto.randomUUID(), text: `UICASE:${JSON.stringify(input)}` }), { sessionId: actor.session.id, input });
      if (!sent.ok) throw new Error(sent.error.code);
      const state = await page.evaluate(async ({ sessionId, runId }) => {
        const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
        return await new Promise<string>((resolve, reject) => {
          let unsubscribe = (): void => {};
          const accept = (run: { id: string; state: string } | undefined): void => {
            if (run?.id === runId && ["completed", "failed", "cancelled", "interrupted"].includes(run.state)) {
              unsubscribe(); resolve(run.state);
            }
          };
          unsubscribe = api.events.subscribeRuntime(event => { if (event.sessionId === sessionId) accept(event.run); });
          // Subscribe before the snapshot so a fast completion cannot be lost.
          void api.runtime.getSessionSnapshot(sessionId).then(result => {
            if (!result.ok) { unsubscribe(); reject(new Error(result.error.code)); }
            else accept(result.data.runs.find(run => run.id === runId));
          }).catch(error => { unsubscribe(); reject(error); });
        });
      }, { sessionId: actor.session.id, runId: sent.data.runId });
      expect(state).toBe("completed");
      const approvals = await page.evaluate(async (sessionId) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.approvals.listPending({ sessionId }), actor.session.id);
      expect(approvals.ok && approvals.data).toEqual([]);
      await expect(page.getByTestId("tool-permission-dialog")).toBeHidden();
    };
    await run({ action: "open_settings", section: "capabilities" });
    await expect(page.getByRole("heading", { name: "能力与权限", exact: true })).toBeVisible();
    await expect(page.locator('[data-capability="product.operations"]')).toContainText("可用");
    await run({ action: "open_settings", section: "models" });
    const settings = page.getByRole("dialog", { name: "设置", exact: true });
    await expect(settings.getByRole("region", { name: "模型设置", exact: true })).toBeVisible();
    await settings.getByLabel("管理 API", { exact: true }).click();
    await settings.getByLabel("API Key", { exact: true }).fill("UNSAVED_MODEL_KEY");
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: "通用", exact: true }).click();
    await expect(settings.getByRole("region", { name: "模型设置", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(settings).toBeVisible();
    await run({ action: "open_chats" });
    await expect(settings).toBeVisible();
    await run({ action: "open_settings", section: "general" });
    await expect(settings.getByLabel("API Key", { exact: true })).toHaveValue("UNSAVED_MODEL_KEY");
    await expect(settings.getByRole("alert")).toContainText("尚未保存");
    await settings.getByRole("button", { name: "放弃修改", exact: true }).click();
    await run({ action: "open_chats" });
    await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
    await run({ action: "sidebar_search", query: "界面操作验收" });
    await expect(page.getByLabel("搜索聊天")).toHaveValue("界面操作验收");
    await run({ action: "task_details", sessionId: actor.session.id, tab: "records" });
    await expect(page.getByRole("tab", { name: /^执行记录/u })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("complementary", { name: "会话成果", exact: true }).getByRole("button", { name: "关闭会话成果", exact: true }).click();
    await page.getByLabel("消息", { exact: true }).fill("用户尚未发送的草稿");
    const currentDraft = await page.evaluate(name => new Promise<ProductViewResult>(resolve => {
      window.dispatchEvent(new CustomEvent(name, { detail: { request: { id: crypto.randomUUID(), input: { action: "draft_get" } }, respond: resolve } }));
    }), PRODUCT_VIEW_DOM_EVENT);
    expect(currentDraft.status).toBe("completed");
    const draftVersion = (currentDraft.result as { draftVersion: number }).draftVersion;
    expect(typeof draftVersion).toBe("number");
    await run({ action: "draft_update", sessionId: actor.session.id, expectedDigest: "0".repeat(64), expectedDraftVersion: draftVersion, text: "不应覆盖用户草稿" });
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue("用户尚未发送的草稿");
    expect(errors).toEqual([]);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isVisible()))).toBe(false);
    await page.screenshot({ path: join(process.env.AEVOREN_PRODUCT_EVIDENCE_DIR ?? tmpdir(), "product-view-draft-protection.png") });
  } finally {
    try {
      try {
        // A failed assertion can leave this fixture's intentionally dirty key.
        // Discard only that test draft through the existing UI before shutdown.
        const page = await application.firstWindow();
        const discard = page.getByRole("dialog", { name: "设置", exact: true }).getByRole("button", { name: "放弃修改", exact: true });
        if (await discard.isVisible()) await discard.click();
      } finally { await closeTestApplicationWithExit(application); }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      removeTestDirectory(data);
    }
  }
});

test("keeps approved Runtime draft reads inside their own chat when another draft is open", async () => {
  const data = mkdtempSync(join(tmpdir(), "aevoren-draft-view-scope-"));
  const databasePath = join(data, "aevoren-bot.sqlite");
  const repository = new AppRepository(databasePath);
  const bots = ["草稿范围甲", "草稿范围乙"].map(name => {
    const created = repository.createBot();
    repository.updateBot(created.bot.id, created.bot.version, { name, mcpServerIds: [],
      modelSelection: { providerInstanceId: "openai-compatible.default", modelId: "fixture-draft-scope" } });
    return { ...created, name };
  });
  const [actor, other] = bots as [typeof bots[number], typeof bots[number]];
  repository.setSetting("memory.capture.enabled", "false", false);
  repository.close();
  const replies = new Map<string, string>();
  const runtimeIds: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const command = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
    const user = command.messages.filter(message => message.role === "user").at(-1)!;
    const fixture = JSON.parse(user.content.slice(user.content.indexOf("DRAFTCASE:") + 10)) as { name: string; input: ProductViewInput };
    const toolResult = command.messages.at(-1);
    const tools = toolResult?.role !== "tool";
    if (!tools) replies.set(fixture.name, toolResult!.content);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = tools ? { tool_calls: [{ index: 0, id: crypto.randomUUID(), type: "function",
      function: { name: "product_execute", arguments: JSON.stringify({ operation: "view.request", input: fixture.input }) } }] }
      : { content: "受控调用已结束。" };
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: tools ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture server unavailable");
  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}),
      args: [...(executablePath ? [] : ["."]), "--use-mock-keychain"], cwd: process.cwd(), env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !key.startsWith("AEVOREN_BOT_"))),
        AEVOREN_BOT_USER_DATA_DIR: data, AEVOREN_BOT_DB_PATH: databasePath, AEVOREN_BOT_FAKE_PROVIDER: "0",
        AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_DISABLE_UPDATES: "1",
      } });
    const page = await application.firstWindow(), errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const appIdentity = await application.evaluate(({ app }) => ({ path: app.getAppPath(), version: app.getVersion(), isPackaged: app.isPackaged }));
    await page.waitForURL(pathToFileURL(join(appIdentity.path, "out/renderer/index.html")).href, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".app-shell")).toBeVisible();
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
    await page.evaluate(async baseUrl => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const providers = await api.providers.list(), provider = providers.ok ? providers.data.find(item => item.id === "openai-compatible.default") : undefined;
      if (!provider) throw new Error("API source unavailable");
      const saved = await api.providers.saveOpenAiCompatible({ instanceId: provider.id, expectedVersion: provider.version, baseUrl, apiKey: "controlled-draft-scope-token" });
      if (!saved.ok) throw new Error(saved.error.code);
      const forwarded: ProductViewInput[] = [];
      Object.assign(window, { draftScopeForwarded: forwarded });
      api.events.subscribeProductView(request => forwarded.push(request.input));
    }, `http://127.0.0.1:${address.port}/v1`);
    const open = async (name: string) => {
      await page.getByRole("listitem", { name, exact: true }).click();
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    };
    const send = async (name: string, input: ProductViewInput) => {
      const sent = await page.evaluate(async ({ sessionId, name, input }) => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.messages.send({
        sessionId, clientNonce: crypto.randomUUID(), text: `DRAFTCASE:${JSON.stringify({ name, input })}`,
      }), { sessionId: actor.session.id, name, input });
      if (!sent.ok) throw new Error(sent.error.code);
      runtimeIds.push(sent.data.runId); return sent.data.runId;
    };
    const approve = async (runtimeRunId: string) => {
      const pending = async () => {
        const result = await page.evaluate(async sessionId => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.approvals.listPending({ sessionId }), actor.session.id);
        if (!result.ok) throw new Error(result.error.code);
        return result.data.find(item => item.runtimeRunId === runtimeRunId);
      };
      await expect.poll(async () => Boolean(await pending())).toBe(true);
      const approval = (await pending())!;
      const result = await page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.approvals.resolve(input), {
        sessionId: actor.session.id, id: approval.id, expectedVersion: approval.version, resolution: "allow-once" as const,
      });
      if (!result.ok) throw new Error(result.error.code);
    };
    const completed = async (runId: string) => {
      await expect.poll(async () => {
        const state = await page.evaluate(async sessionId => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.runtime.getSessionSnapshot(sessionId), actor.session.id);
        return state.ok ? state.data.runs.find(item => item.id === runId)?.state : null;
      }).toBe("completed");
    };
    const forwarded = () => page.evaluate(() => (window as unknown as { draftScopeForwarded: ProductViewInput[] }).draftScopeForwarded);
    await open(other.name);
    const foreignDraft = "CONTROLLED_B_UNSENT_DRAFT_DO_NOT_DISCLOSE";
    await page.getByLabel("消息", { exact: true }).fill(foreignDraft);
    const omitted = await send("omitted-session", { action: "draft_get" });
    await approve(omitted); await completed(omitted);
    expect(JSON.parse(replies.get("omitted-session")!)).toMatchObject({ ok: true, status: "waiting_user" });
    expect(replies.get("omitted-session")).not.toContain(foreignDraft);
    expect(await forwarded()).toEqual([{ action: "draft_get", sessionId: actor.session.id }]);
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(foreignDraft);

    const explicit = await send("foreign-session", { action: "draft_get", sessionId: other.session.id });
    await completed(explicit);
    expect(JSON.parse(replies.get("foreign-session")!)).toMatchObject({ ok: false, code: "PRODUCT_VIEW_SCOPE_INVALID" });
    expect(await forwarded()).toHaveLength(1);
    expect(replies.get("foreign-session")).not.toContain(foreignDraft);

    await open(actor.name);
    const ownDraft = "CONTROLLED_A_OWN_UNSENT_DRAFT";
    await page.getByLabel("消息", { exact: true }).fill(ownDraft);
    const own = await send("own-session", { action: "draft_get" });
    await approve(own); await completed(own);
    expect(JSON.parse(replies.get("own-session")!)).toMatchObject({ ok: true, status: "completed", result: { sessionId: actor.session.id, text: ownDraft } });
    expect(replies.get("own-session")).not.toContain(foreignDraft);
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(ownDraft);
    await open(other.name);
    await expect(page.getByLabel("消息", { exact: true })).toHaveValue(foreignDraft);
    expect(errors).toEqual([]);
    const hidden = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()));
    expect(hidden).toBe(true);
    const evidence = process.env.AEVOREN_PRODUCT_EVIDENCE_DIR ?? test.info().outputPath("draft-view-scope");
    mkdirSync(evidence, { recursive: true });
    const receipt = join(evidence, "draft-view-cross-chat.json");
    writeFileSync(receipt, JSON.stringify({ appIdentity, hidden, source: "controlled-local-HTTP-provider", results: Object.fromEntries(replies), forwarded: await forwarded(), pageErrors: errors }, null, 2));
    await test.info().attach("draft-view-cross-chat", { path: receipt, contentType: "application/json" });
  } finally {
    try {
      if (application) {
        await application.windows()[0]?.evaluate(async ids => {
          const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
          await Promise.all(ids.map(id => api.runtime.cancel(id)));
        }, runtimeIds).catch(() => undefined);
        await closeTestApplicationWithExit(application);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      removeTestDirectory(data);
    }
  }
});
