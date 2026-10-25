import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { PromptManifest } from "@shared/contracts";
import { AppRepository } from "../../src/main/database";
import { removeTestDirectory } from "./test-cleanup";

test("keeps a recoverable partial-reply failure card beside the Bot message", async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), "aevoren-room-failure-inline-"));
  const repository = new AppRepository(join(userDataDir, "aevoren-bot.sqlite"));
  const first = repository.createBot().bot;
  const second = repository.createBot().bot;
  const room = repository.createRoom({ name: "部分回复失败群聊", memberBotIds: [first.id, second.id] });
  const clientNonce = randomUUID();
  const prepared = repository.createRoomRunWithInitialTurns({
    roomId: room.room.id,
    sessionId: room.session.id,
    clientNonce,
    text: "生成草稿",
    membershipVersion: room.room.membershipVersion,
    maxTurns: 8,
    maxHops: 3,
    maxTargetsPerTurn: 2,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    initialTurns: [{ agentId: first.id, nonce: randomUUID() }],
    routingMode: "automatic",
    routingReason: "UI fixture: failed after partial output",
    orchestrationEnabled: true,
  });
  const turn = prepared.turns[0]!;
  repository.transitionRoomRun(prepared.run.id, "running");
  repository.transitionAgentTurn(turn.id, "running", { promptCutoffSeq: turn.inputSeq });
  const manifest: PromptManifest = {
    schemaVersion: 4,
    botId: first.id,
    profileVersion: first.version,
    sessionId: room.session.id,
    generation: room.session.generation,
    inputSeq: turn.inputSeq,
    promptCutoffSeq: turn.inputSeq,
    roomId: room.room.id,
    roomMembershipVersion: room.room.membershipVersion,
    executorBotId: first.id,
    sourceTurnId: turn.id,
    blocks: [],
    digest: "partial-reply-failure-ui",
  };
  let runtime = repository.createRuntimeRun(clientNonce, "fake", manifest, {
    executorBotId: first.id,
    executionKey: `${prepared.run.id}:${turn.logicalTurnId}`,
  });
  repository.attachRoomTurnRuntime(turn.id, runtime.id);
  runtime = repository.transitionRuntimeRun(runtime.id, "dispatching");
  runtime = repository.transitionRuntimeRun(runtime.id, "running", { providerRequestId: "partial-reply-failure-ui" });
  const assistant = repository.createAssistantEntry(room.session.id, {
    speakerBotId: first.id,
    speakerNameSnapshot: first.name,
    sourceTurnId: turn.id,
  });
  repository.attachAssistantEntry(runtime.id, assistant.id);
  repository.updateTranscriptEntry(assistant.id, "已形成一段草稿，但回复未完成。", "failed");
  repository.transitionRuntimeRun(runtime.id, "failed", { errorCode: "MODEL_STREAM_TRUNCATED" });
  repository.transitionAgentTurn(turn.id, "failed", { errorCode: "MODEL_STREAM_TRUNCATED", outcome: { kind: "error" } });
  repository.transitionRoomRun(prepared.run.id, "partial");
  repository.setSetting("appearance.theme", "dark", false);
  repository.close();

  let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    application = await electron.launch({
      args: ["."],
      cwd: process.cwd(),
      env: {
        ...process.env,
        AEVOREN_BOT_USER_DATA_DIR: userDataDir,
        AEVOREN_BOT_FAKE_PROVIDER: "1",
        AEVOREN_BOT_TEST_HIDDEN: "1",
      },
    });
    const page = await application.firstWindow();
    await page.locator(".bot-row").filter({ hasText: room.room.name }).click();
    await expect(page.locator("article.message-assistant[data-status=\"failed\"]")).toContainText("已形成一段草稿");
    const failure = page.locator(".room-inline-failure").getByRole("alert");
    await expect(failure).toContainText("模型回复在完成前中断。");
    await expect(failure.getByRole("button", { name: "重试此步骤" })).toBeEnabled();
    await expect(page.locator(".composer-run-status .run-status-card")).toHaveCount(0);
    await page.screenshot({ path: join(tmpdir(), "aevoren-room-failure-ui-inline.png") });
    for (const width of [1180, 1020, 620, 390]) {
      await application.evaluate(({ BrowserWindow }, nextWidth) => BrowserWindow.getAllWindows()[0]?.setSize(nextWidth, 900), width);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
      expect(await failure.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.left >= 0 && bounds.right <= window.innerWidth && element.scrollWidth <= element.clientWidth;
      })).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 900));
  } finally {
    if (application) await application.close();
    removeTestDirectory(userDataDir);
  }
});
