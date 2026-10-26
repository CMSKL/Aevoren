import { APPLICATION_PRODUCT_OPERATIONS, APPLICATION_OPERATION_SCHEMAS } from "@shared/application-contracts";
import type { ApplicationService } from "./application-service";
import { BROWSER_PRODUCT_OPERATIONS, BROWSER_OPERATION_SCHEMAS } from "@shared/browser-product";
import { ENVIRONMENT_PRODUCT_OPERATIONS, ENVIRONMENT_OPERATION_SCHEMAS } from "@shared/environment-product";
import type { ProductOperationDefinition } from "@shared/product-operations";
import type { ComputerTask } from "@shared/computer-task-contracts";
import type { BrowserScope, ComputerScreenshot } from "@shared/browser-contracts";
import type { z } from "zod";
import type { ModelImageAttachment } from "./model-image";
import type { AppRepository } from "./database";
import type { BrowserCallContext, BrowserService } from "./browser-service";
import type { EnvironmentService } from "./environment-service";
import { addEnvironmentProductHandlers } from "./environment-product-handlers";
import { AevorenBotError } from "./errors";

export type ComputerToolResult = { result: unknown; images?: ModelImageAttachment[] };
export interface ComputerToolGateway {
  definitions: readonly ProductOperationDefinition[];
  definitionsFor?(task: ComputerTask): readonly ProductOperationDefinition[];
  schemasFor?(task: ComputerTask): Record<string, z.ZodType>;
  target?(): import("@shared/host-computer-contracts").ComputerTarget;
  hostTarget?(): import("@shared/host-computer-targets").HostComputerTarget | null;
  schemas: Record<string, z.ZodType>;
  prepare(task: ComputerTask, signal: AbortSignal): Promise<ComputerToolResult>;
  execute(task: ComputerTask, operation: string, input: unknown, stepId: string, signal: AbortSignal): Promise<ComputerToolResult>;
  cancel(task: ComputerTask): Promise<void>;
  releaseInput?(task: ComputerTask): Promise<void>;
  assertAI(scope: BrowserScope & Pick<ComputerTask, "target" | "hostTarget">): void;
}

export function createComputerToolGateway(repository: AppRepository, browser: BrowserService, environments: EnvironmentService, applications?: ApplicationService): ComputerToolGateway {
  const browserNames: Record<string, string> = { windows: "computerWindows", focusWindow: "computerFocusWindow", view: "view", screenshot: "computerScreenshot", click: "computerClick", type: "computerType", key: "computerKey", scroll: "computerScroll", move: "computerMove", mouseDown: "computerMouseDown", mouseUp: "computerMouseUp", drag: "computerDrag" };
  const previewNames: Record<string, string> = { list: "previewList", open: "previewOpen", close: "previewClose" };
  const definitions = [
    ...APPLICATION_PRODUCT_OPERATIONS,
    ...BROWSER_PRODUCT_OPERATIONS.filter(definition => definition.name.startsWith("browser.") ? !["browser.stop", "browser.download"].includes(definition.name) :
      definition.name.startsWith("computer.") && Object.hasOwn(browserNames, definition.name.slice(9)) || definition.name.startsWith("preview.") && Object.hasOwn(previewNames, definition.name.slice(8))),
    ...ENVIRONMENT_PRODUCT_OPERATIONS.filter(definition => /^(execution|processes)\./u.test(definition.name) && !["execution.pickUpload", "execution.downloadFile"].includes(definition.name)),
  ];
  const schemas = { ...APPLICATION_OPERATION_SCHEMAS, ...BROWSER_OPERATION_SCHEMAS, ...ENVIRONMENT_OPERATION_SCHEMAS };
  const scopeOf = (value: BrowserScope): BrowserScope => ({ sessionId: value.sessionId, executorBotId: value.executorBotId });
  const assertAI = (scope: BrowserScope): void => {
    repository.assertSessionExecutor(scope.sessionId, scope.executorBotId);
    if (repository.browsers.view(scope)?.owner === "user") throw new AevorenBotError("COMPUTER_USER_CONTROLLED");
  };
  const shot = async (scope: BrowserScope, signal: AbortSignal): Promise<ComputerToolResult> => {
    scope = scopeOf(scope);
    assertAI(scope);
    const view = await browser.view(scope, { actor: "ai", signal });
    if (!view) throw new AevorenBotError("BROWSER_UNAVAILABLE");
    const value = await browser.computerScreenshot({ ...scope, expectedEpoch: view.epoch }, { actor: "ai", signal });
    const image = await browser.imageAttachment(scope, value.media.id, value.media.controlEpoch);
    return { result: { media: value.media, imageTransfer: "prepared_real_pixels" }, images: [image] };
  };
  return {
    definitions, schemas, assertAI,
    async prepare(task, signal) {
      assertAI(task); await browser.start({ ...scopeOf(task), clientNonce: task.id }, { actor: "ai", signal });
      return shot(task, signal);
    },
    async execute(task, operation, input, stepId, signal) {
      assertAI(task); signal.throwIfAborted();
      const definition = definitions.find(definition => definition.name === operation);
      if (!definition) throw new AevorenBotError("INVALID_REQUEST");
      const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
      if (raw.sessionId !== undefined && raw.sessionId !== task.sessionId || raw.executorBotId !== undefined && raw.executorBotId !== task.executorBotId) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
      const scoped = { ...raw, sessionId: task.sessionId, executorBotId: task.executorBotId };
      const parsed = schemas[operation]!.parse(scoped) as Record<string, unknown>;
      const mutates = !["read-local", "read-remote", "pure"].includes(definition.effectClass);
      const usesNonce = !/^(execution|processes)\./u.test(operation) || ["execution.run", "processes.start"].includes(operation);
      const command = mutates && usesNonce ? { ...parsed, clientNonce: stepId } : parsed;
      let result: unknown;
      if (operation.startsWith("browser.") || operation.startsWith("computer.") || operation.startsWith("preview.")) {
        const method = operation.startsWith("browser.") ? operation.slice(8) : operation.startsWith("preview.") ? previewNames[operation.slice(8)]! : browserNames[operation.slice(9)]!;
        const invoke = (browser as unknown as Record<string, (input: unknown, context: BrowserCallContext) => Promise<unknown>>)[method]!;
        result = await invoke.call(browser, command, { actor: "ai", signal, operationId: stepId });
      } else if (operation.startsWith("applications.")) {
        if (!applications) throw new AevorenBotError("BROWSER_UNAVAILABLE");
        const value = { ...parsed, clientNonce: stepId };
        result = operation === "applications.list" ? applications.list(scopeOf(task)) : operation === "applications.install" ? await applications.install(value as import("@shared/application-contracts").ApplicationInstall, true) : await applications.launch(value as import("@shared/application-contracts").ApplicationLaunch, true, task.id);
      } else {
        const handlers = new Map<string, (input?: unknown) => unknown>();
        addEnvironmentProductHandlers(handlers, { repository, environmentService: environments }, undefined, undefined, signal);
        result = await handlers.get(definition.channel)!(command);
      }
      assertAI(task); signal.throwIfAborted();
      if (operation === "computer.screenshot") {
        const value = result as ComputerScreenshot;
        return { result: { media: value.media, imageTransfer: "prepared_real_pixels" }, images: [await browser.imageAttachment(task, value.media.id, value.media.controlEpoch)] };
      }
      if (definition.effectClass === "read-local" || definition.effectClass === "pure" || definition.effectClass === "read-remote") return { result };
      try { const frame = await shot(task, signal); return { result: { action: result, feedback: frame.result }, images: frame.images }; }
      catch (error) {
        signal.throwIfAborted(); assertAI(task);
        return { result: { action: result, feedback: { status: "unavailable", code: error instanceof AevorenBotError ? error.code : "BROWSER_UNAVAILABLE", actionAlreadyExecuted: true } } };
      }
    },
    releaseInput(task) { return browser.releaseInput(scopeOf(task)); },
    async cancel(task) {
      await applications?.stopScope(scopeOf(task), true, task.id);
      for (const step of repository.computerTasks.steps(task).filter(step => step.operation === "applications.install")) {
        const application = repository.applications.findByNonce(task, step.id);
        if (application) applications?.cancelBuild(scopeOf(task), application.id);
      }
      const ids = repository.computerTasks.steps(task).filter(step => step.operation === "execution.run").flatMap(step => {
        const execution = repository.environments.findExecutionByNonce(task, step.id);
        return execution ? [execution.id] : [];
      });
      await Promise.all(ids.map(async id => {
        const current = await environments.getExecution({ ...scopeOf(task), id });
        if (["running", "unknown"].includes(current.state)) await environments.cancel({ ...scopeOf(task), id });
      }));
    },
  };
}
