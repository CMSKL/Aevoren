import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { AppRepository } from "./database";
import type { ModelProvider } from "./model";
import { RuntimeExecutor, STALE_AFTER_MS } from "./runtime-executor";

it("notifies at thirty seconds after dispatch activity and remains cancellable", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-18T00:00:00.000Z"));
  const repository = new AppRepository(":memory:");
  const { bot, session } = repository.createBot();
  const clientNonce = randomUUID();
  repository.prepareMessage({ sessionId: session.id, clientNonce, text: "等待模型" });
  repository.acknowledgeUserMessage(clientNonce);
  const transition = repository.transitionRuntimeRun.bind(repository);
  vi.spyOn(repository, "transitionRuntimeRun").mockImplementation((...args) => {
    // Dispatch persistence can happen in the next millisecond after creation.
    if (args[1] === "dispatching") vi.advanceTimersByTime(1);
    return transition(...args);
  });
  const states: string[] = [];
  const provider: ModelProvider = {
    async *run(_messages, signal) {
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
      yield { type: "completed", finishReason: "stop" };
    },
    async testConnection() {},
  };
  const runtime = new RuntimeExecutor(repository, null, {
    transcript() {}, runtime(event) { states.push(event.liveState.state); },
  }, false, provider);
  try {
    const started = runtime.start({ clientNonce, executorBotId: bot.id, executionKey: bot.id });
    await vi.advanceTimersByTimeAsync(STALE_AFTER_MS - 1);
    expect(runtime.getLiveState(session.id).state).toBe("starting");
    expect(states).not.toContain("stale");
    await vi.advanceTimersByTimeAsync(1);
    expect(states.at(-1)).toBe("stale");
    runtime.cancelRun(started.run.id);
    expect((await started.completion).run.state).toBe("cancelled");
    expect(runtime.getLiveState(session.id).state).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await runtime.shutdown();
    repository.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});
