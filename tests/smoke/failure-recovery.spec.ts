import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import type { PromptManifest, RuntimeRoute } from "../../src/shared/contracts";
import { AppRepository } from "../../src/main/database";
import { WorkspaceService } from "../../src/main/workspace-service";
import { WorkspaceToolExecutor } from "../../src/main/workspace-tool-executor";
import { captureElectron } from "./electron-screenshot";
import { closeTestApplicationWithExit, removeTestDirectory } from "./test-cleanup";

// Persisted failure fixtures, not real model/engine failures. The successful read
// is real; the unknown mutation is a Journal fixture and is never dispatched.
test("restores precise failure guidance and safe retry intersection from persisted Runtime and Journal", async () => {
  test.setTimeout(90_000);
  const directory = mkdtempSync(join(tmpdir(), "aevoren-failure-guidance-"));
  const root = join(directory, "workspace"); mkdirSync(root); writeFileSync(join(root, "proof.txt"), "real retained read");
  const repository = new AppRepository(join(directory, "app.sqlite")), workspaceService = new WorkspaceService(repository);
  const workspace = await workspaceService.registerRoot(root);
  const executor = new WorkspaceToolExecutor(repository, workspaceService);
  const cases: Array<{ code: string; text: string; retry: boolean; unknown?: boolean; route?: RuntimeRoute }> = [
    { code: "MEASUREMENT_EVIDENCE_REQUIRED", text: "补齐计数证据", retry: true },
    { code: "TASK_REQUIREMENTS_UNMET", text: "只补齐尚未完成的要求", retry: true },
    { code: "COMPUTER_MEMORY_INSUFFICIENT", text: "先在电脑面板", retry: false },
    { code: "TOOL_ROUND_LIMIT_EXCEEDED", text: "缩小剩余任务", retry: false },
    { code: "MODEL_CONNECTION_TIMEOUT", text: "先只读核对实际状态", retry: false, unknown: true },
    { code: "NETWORK_TOOL_TIMEOUT", text: "在应用页只读核对未知结果", retry: false, route: "host-mcp" },
    { code: "NETWORK_TOOL_TIMEOUT", text: "检查连接或服务状态", retry: true },
  ];
  const fixtures = [];
  for (const [index, item] of cases.entries()) {
    const actor = repository.createBot(workspace.project.id), name = `错误恢复验收 ${index + 1}`;
    repository.updateBot(actor.bot.id, actor.bot.version, { name });
    const clientNonce = randomUUID(); repository.prepareMessage({ sessionId: actor.session.id, clientNonce, text: "持久错误展示夹具，不发送业务" });
    repository.acknowledgeUserMessage(clientNonce);
    const manifest: PromptManifest = { schemaVersion: 1, botId: actor.bot.id, profileVersion: 1, sessionId: actor.session.id, generation: 1, inputSeq: 1, blocks: [], digest: "failure-guidance-fixture" };
    const run = repository.createRuntimeRun(clientNonce, item.route ?? "fake", manifest);
    repository.transitionRuntimeRun(run.id, "dispatching"); repository.transitionRuntimeRun(run.id, "running", { providerRequestId: "persisted-ui-fixture" });
    const prepared = repository.prepareToolInvocation({ runtimeRunId: run.id, toolCallId: randomUUID(), idempotencyKey: randomUUID(), tool: { kind: "workspace-read", workspaceId: workspace.workspace.id, path: "proof.txt", maxBytes: 1024 } });
    repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
    expect((await executor.execute(prepared.invocation.id)).invocation.state).toBe("succeeded");
    if (item.unknown) {
      const command = repository.prepareToolInvocation({ runtimeRunId: run.id, toolCallId: randomUUID(), idempotencyKey: randomUUID(), tool: { kind: "product-call", action: "execute", operation: "computer.click", input: { expectedEpoch: 1, observationId: randomUUID(), x: 10, y: 10 } } });
      repository.resolveToolApproval(command.approval.id, command.approval.version, "allow-once");
      repository.transitionToolInvocation(command.invocation.id, "dispatching"); repository.transitionToolInvocation(command.invocation.id, "running");
      repository.transitionToolInvocation(command.invocation.id, "interrupted-unknown");
    }
    const assistant = repository.createAssistantEntry(actor.session.id);
    repository.updateTranscriptEntry(assistant.id, "仅用于检查错误卡片，不作为业务完成结果。", "failed");
    repository.transitionRuntimeRun(run.id, "failed", { errorCode: item.code, assistantEntryId: assistant.id });
    fixtures.push({ ...item, name, sessionId: actor.session.id, runId: run.id });
  }
  repository.close();
  let application: ElectronApplication | undefined;
  const evidence: unknown[] = [];
  try {
    for (let opening = 0; opening < 2; opening += 1) {
      application = await electron.launch({ args: ["."], cwd: process.cwd(), env: { ...process.env, AEVOREN_BOT_DB_PATH: join(directory, "app.sqlite"), AEVOREN_BOT_USER_DATA_DIR: directory, AEVOREN_BOT_TEST_HIDDEN: "1", AEVOREN_BOT_FAKE_PROVIDER: "1", AEVOREN_BOT_DISABLE_UPDATES: "1" } });
      const page = await application.firstWindow();
      for (const [index, item] of fixtures.entries()) {
        await page.locator(".sidebar").getByRole("listitem", { name: item.name, exact: true }).click();
        const card = page.locator('.run-status-card[role="alert"]');
        await expect(card).toContainText(item.text);
        await expect(card).toContainText("1 次真实工具执行");
        await expect(card).not.toContainText("不会重复覆盖");
        await expect(card.getByRole("button", { name: "重试此步骤", exact: true })).toHaveCount(item.retry ? 1 : 0);
        await card.getByText("技术详情", { exact: true }).click(); await expect(card.locator("code")).toHaveText(item.code);
        await page.getByRole("button", { name: "聊天选项", exact: true }).click();
        await expect(page.getByRole("menu", { name: "聊天选项", exact: true }).getByRole("menuitem", { name: "重新生成回复", exact: true })).toHaveCount(item.retry ? 1 : 0);
        await page.getByRole("button", { name: "聊天选项", exact: true }).click();
        if (opening === 1 && index === 0) await captureElectron(application, test.info().outputPath("measurement-after-restart.png"), card);
        if (opening === 1 && item.unknown) await captureElectron(application, test.info().outputPath("unknown-effect-after-restart.png"), card);
        evidence.push({ opening, code: item.code, unknown: item.unknown ?? false, retryVisible: item.retry, realReadCount: 1 });
      }
      expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible() && !window.isFocused()))).toBe(true);
      await closeTestApplicationWithExit(application); application = undefined;
    }
    const checked = new AppRepository(join(directory, "app.sqlite"));
    expect(checked.listRuntimeRuns(fixtures[0]!.sessionId)).toHaveLength(1);
    expect(checked.listToolInvocations(fixtures[4]!.sessionId).find(tool => tool.state === "interrupted-unknown")).toBeDefined(); checked.close();
    const output = test.info().outputPath("persisted-error-guidance.json");
    writeFileSync(output, JSON.stringify({ realModel: false, persistedFixtures: true, normalExits: 2, cases: evidence }, null, 2));
    await test.info().attach("persisted-error-guidance", { path: output, contentType: "application/json" });
  } finally {
    try { if (application) await closeTestApplicationWithExit(application); }
    finally { removeTestDirectory(directory); }
  }
});
