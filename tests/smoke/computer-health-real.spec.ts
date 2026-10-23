import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import type { AevorenBotApi } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { selectDetailsTab } from "./navigation";
import { captureElectron } from "./electron-screenshot";
import { closeTestApplicationWithExit } from "./test-cleanup";

const command = promisify(execFile);
test("actual engine exit revokes ready in IPC and the hidden computer panel without changing human ownership", async () => {
  test.skip(process.env.AEVOREN_REAL_COMPUTER_HEALTH !== "1", "requires the real local Docker engine");
  test.setTimeout(240_000);
  const directory = mkdtempSync(join(tmpdir(), "aevoren-health-real-")), path = join(directory, "app.sqlite");
  const repository = new AppRepository(path), actor = repository.createBot();
  repository.updateBot(actor.bot.id, actor.bot.version, { name: "电脑健康验收" }); repository.close();
  const scope = { sessionId: actor.session.id, executorBotId: actor.bot.id };
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AEVOREN_BOT_")));
  let application: ElectronApplication | undefined, normalExit = false, cleanupError: unknown;
  const evidence: Record<string, unknown> = { simulatedWorker: false, simulatedModel: false, modelUsed: false };
  try {
    application = await electron.launch({ args: [".", "--use-mock-keychain"], cwd: process.cwd(), env: { ...inherited,
      AEVOREN_BOT_USER_DATA_DIR: directory, AEVOREN_BOT_DB_PATH: path, AEVOREN_BOT_FAKE_PROVIDER: "1", AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_TEST_HIDDEN: "1" } });
    const page = await application.firstWindow(); await expect(page.locator(".app-shell")).toBeVisible();
    const started = await page.evaluate(async input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.browser.start(input), { ...scope, clientNonce: randomUUID() });
    if (!started.ok) throw new Error(started.error.code);
    const before = await page.evaluate(async scope => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const startup = await api.computer.startupStatus(scope); if (!startup.ok || startup.data?.phase !== "ready") throw new Error("READY_NOT_VERIFIED");
      const taken = await api.computer.takeover({ ...scope, expectedEpoch: 1, clientNonce: crypto.randomUUID() }); if (!taken.ok) throw new Error(taken.error.code);
      return { startup: startup.data, view: taken.data };
    }, scope);
    evidence.before = before;
    await page.locator(".sidebar").getByRole("listitem", { name: "电脑健康验收", exact: true }).click();
    await page.getByRole("button", { name: "查看对话详情", exact: true }).click();
    await selectDetailsTab(page.getByRole("main", { name: "联系人资料", exact: true }), "电脑");
    await expect(page.locator(".computer-heading").getByRole("status")).toHaveText("运行中");
    const name = `aevoren-browser-${started.data.id}`;
    await command("docker", ["exec", name, "pkill", "-TERM", "-f", "/engine.mjs"]);
    await expect.poll(async () => {
      const value = await page.evaluate(async scope => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.browser.get(scope), scope);
      return value.ok ? value.data?.state : null;
    }).toBe("error");
    const after = await page.evaluate(async scope => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const state = await api.browser.get(scope), startup = await api.computer.startupStatus(scope), view = await api.computer.view(scope);
      if (!state.ok || !startup.ok || !view.ok) throw new Error("HEALTH_QUERY_FAILED"); return { state: state.data, startup: startup.data, view: view.data };
    }, scope);
    evidence.after = after;
    expect(after.state?.state).toBe("error"); expect(after.state?.startup?.errorCode).toBe("COMPUTER_DESKTOP_UNAVAILABLE");
    expect(after.startup).toMatchObject({ phase: "error", errorCode: "COMPUTER_DESKTOP_UNAVAILABLE", bootId: before.startup.bootId });
    expect(after.view).toMatchObject({ owner: "user", epoch: before.view.epoch });
    await expect(page.locator(".computer-heading").getByRole("status")).toHaveText("需要处理");
    await expect(page.getByRole("heading", { name: "电脑引擎已停止，请检查当前电脑后重新启动", exact: true })).toBeVisible();
    await captureElectron(application, test.info().outputPath("actual-engine-failed.png"), page.locator(".computer-panel"));
    evidence.oomEvents = (await command("docker", ["exec", name, "cat", "/sys/fs/cgroup/memory.events"])).stdout;
    expect(evidence.oomEvents).toMatch(/oom_kill 0/u);
    expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFocused()))).toBe(true);
    evidence.businessCompleted = true;
  } finally {
    if (application) {
      try {
        const page = await application.firstWindow();
        const cleanup = await page.evaluate(async scope => {
          const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
          return { browser: await api.browser.stop({ ...scope, clientNonce: crypto.randomUUID() }), environment: await api.environments.stop(scope) };
        }, scope);
        evidence.cleanup = cleanup; expect(cleanup.browser.ok && cleanup.environment.ok).toBe(true);
      } catch (error) { cleanupError = error; evidence.cleanupError = error instanceof Error ? error.name : "UNKNOWN"; }
      try { await closeTestApplicationWithExit(application); normalExit = true; }
      catch (error) { cleanupError ??= error; evidence.closeError = error instanceof Error ? error.name : "UNKNOWN"; }
    }
    evidence.normalExit = normalExit;
    const output = test.info().outputPath("actual-computer-health.json"); writeFileSync(output, JSON.stringify(evidence, null, 2));
    await test.info().attach("actual-computer-health", { path: output, contentType: "application/json" });
  }
  if (cleanupError) throw cleanupError;
});
