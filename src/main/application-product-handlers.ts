import { createHash } from "node:crypto";
import { APPLICATION_PRODUCT_OPERATIONS, APPLICATION_OPERATION_SCHEMAS, applicationInstallSchema, applicationLaunchSchema } from "@shared/application-contracts";
import { browserScopeSchema } from "@shared/browser-schemas";
import type { AppRepository } from "./database";
import type { ApplicationService } from "./application-service";
import type { LibraryExecutionContext } from "./library-product-handlers";
import { AevorenBotError } from "./errors";
export type ApplicationDependencies = { repository: AppRepository; applicationService?: ApplicationService };
export function addApplicationProductHandlers(handlers: Map<string, (input?: unknown) => unknown>, dependencies: ApplicationDependencies, context?: LibraryExecutionContext): void {
  for (const operation of APPLICATION_PRODUCT_OPERATIONS) handlers.set(operation.channel, input => {
    context?.signal?.throwIfAborted();
    const service = dependencies.applicationService;
    if (!service) throw new AevorenBotError("BROWSER_UNAVAILABLE");
    let value = input as Record<string, unknown>;
    if (context) {
      if (value?.sessionId !== undefined && value.sessionId !== context.sessionId || value?.executorBotId !== undefined && value.executorBotId !== context.executorBotId) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
      if (dependencies.repository.browsers.view(context)?.owner === "user") throw new AevorenBotError("COMPUTER_USER_CONTROLLED");
      value = APPLICATION_OPERATION_SCHEMAS[operation.name]!.parse({ ...value, sessionId: context.sessionId, executorBotId: context.executorBotId }) as Record<string, unknown>;
      const hash = createHash("sha256").update(`${dependencies.repository.getRuntimeRun(context.runtimeRunId).clientNonce}:${operation.name}:${JSON.stringify(value)}`).digest("hex");
      if (operation.name !== "applications.list") value = { ...value, clientNonce: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}` };
    }
    if (operation.name === "applications.list") return service.list(browserScopeSchema.parse(value));
    if (operation.name === "applications.install") return service.install(applicationInstallSchema.parse(value), Boolean(context));
    return service.launch(applicationLaunchSchema.parse(value), Boolean(context));
  });
}
