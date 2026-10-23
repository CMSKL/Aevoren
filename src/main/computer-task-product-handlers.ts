import { createHash } from "node:crypto";
import { COMPUTER_TASK_PRODUCT_OPERATIONS, COMPUTER_TASK_OPERATION_SCHEMAS, computerTaskStartSchema, computerTaskIdSchema, computerTaskMutationSchema } from "@shared/computer-task-product";
import { browserScopeSchema } from "@shared/browser-schemas";
import type { AppRepository } from "./database";
import type { ComputerTaskService } from "./computer-task-service";
import type { LibraryExecutionContext } from "./library-product-handlers";
import { AevorenBotError } from "./errors";

export type ComputerTaskDependencies = { repository: AppRepository; computerTaskService?: ComputerTaskService };
export function addComputerTaskProductHandlers(handlers: Map<string, (input?: unknown) => unknown>, dependencies: ComputerTaskDependencies, context?: LibraryExecutionContext): void {
  for (const operation of COMPUTER_TASK_PRODUCT_OPERATIONS) handlers.set(operation.channel, async input => {
    const service = dependencies.computerTaskService;
    if (!service) throw new AevorenBotError("BROWSER_UNAVAILABLE");
    context?.signal?.throwIfAborted();
    if (operation.name === "computer.model.get") return service.configuration();
    if (operation.name === "computer.model.save") return service.saveConfiguration(input);
    if (operation.name === "computer.model.test") return service.test();
    let scoped = input;
    if (context) {
      const raw = (input ?? {}) as Record<string, unknown>;
      if (raw.sessionId !== undefined && raw.sessionId !== context.sessionId || raw.executorBotId !== undefined && raw.executorBotId !== context.executorBotId) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
      scoped = { ...raw, sessionId: context.sessionId, executorBotId: context.executorBotId };
      scoped = COMPUTER_TASK_OPERATION_SCHEMAS[operation.name]!.parse(scoped);
    }
    if (operation.name === "computer.tasks.start") {
      if (context) {
        const hash = createHash("sha256").update(`${dependencies.repository.getRuntimeRun(context.runtimeRunId).clientNonce}:${JSON.stringify(scoped)}`).digest("hex");
        scoped = { ...scoped as object, clientNonce: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}` };
      }
      return service.start(computerTaskStartSchema.parse(scoped), context?.runtimeRunId ?? null, context?.signal);
    }
    if (operation.name === "computer.tasks.list") { const scope = browserScopeSchema.parse(scoped); if (context) service.assertReadable(scope); return service.list(scope); }
    if (operation.name === "computer.tasks.get") { const parsed = computerTaskIdSchema.parse(scoped); if (context) service.assertReadable(parsed, parsed.id); return service.get(parsed); }
    const parsed = computerTaskMutationSchema.parse(scoped);
    if (operation.name !== "computer.tasks.cancel") return service.resume(parsed, context?.runtimeRunId, context?.signal);
    const task = await service.cancel(parsed);
    if (context) {
      try { service.assertReadable(parsed, parsed.id); }
      catch (error) {
        if (!(error instanceof AevorenBotError) || !["COMPUTER_USER_CONTROLLED", "HOST_COMPUTER_PERMISSION"].includes(error.code)) throw error;
        return { id: task.id, state: task.state, version: task.version };
      }
    }
    return task;
  });
}
