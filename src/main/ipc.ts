import { HOST_COMPUTER_CHANNELS } from "@shared/host-computer-contracts";
import { COMPUTER_UI_CHANNELS } from "@shared/browser-channels";
import { browserScopeSchema } from "@shared/browser-schemas";
import { MCP_WRITE_CHANNELS } from "@shared/mcp-write-channels";
import { mcpWriteIdSchema } from "@shared/mcp-write-schemas";
import { NATIVE_OUTBOUND_REQUEST_APPROVAL_CHANNEL } from "@shared/native-outbound-channels";
import { nativeOutboundIdSchema } from "@shared/native-outbound-schemas";
import { z } from "zod";
import { ProductViewService } from "./product-view-service";
import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { IPC } from '@shared/channels';
import { apiResult, AevorenBotError } from './errors';
import { ProductOperationService } from './product-operation-service';
import type { ProductDependencies } from './product-handlers';
import { NATIVE_CONNECTOR_CHANNELS } from '@shared/native-connector-channels';
import { connectorConfigureSchema } from '@shared/native-connector-schemas';

type IpcDependencies = ProductDependencies & { hostComputerService?: import("./host-computer-service").HostComputerService; window: BrowserWindow; rendererReady(): void; confirmClose(canClose: boolean): void };

function isTrusted(event: IpcMainEvent | IpcMainInvokeEvent, window: BrowserWindow): boolean {
  return event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
}

function assertTrusted(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (!isTrusted(event, window)) {
    throw new AevorenBotError("UNTRUSTED_RENDERER", "请求来源不受信任。", false);
  }
}

export function registerIpc(dependencies: IpcDependencies): ProductOperationService {
  const { window } = dependencies;
  const view = new ProductViewService(window);
  const product = new ProductOperationService({ ...dependencies, requestView: (input) => view.request(input) });
  ipcMain.handle(MCP_WRITE_CHANNELS.requestToolApproval, (event, input: unknown) => apiResult(() => {
    assertTrusted(event, window); if (!dependencies.mcpWriteService) throw new AevorenBotError("MCP_SERVER_UNAVAILABLE");
    return dependencies.mcpWriteService.requestApproval(mcpWriteIdSchema.parse(input), dependencies.workspaceToolCoordinator);
  }));
  ipcMain.handle(NATIVE_OUTBOUND_REQUEST_APPROVAL_CHANNEL,(event,input:unknown)=>apiResult(()=>{
    assertTrusted(event,window);if(!dependencies.nativeOutboundService)throw new AevorenBotError("CONNECTOR_UNAVAILABLE");
    return dependencies.nativeOutboundService.requestApproval(nativeOutboundIdSchema.parse(input),dependencies.workspaceToolCoordinator);
  }));
  ipcMain.handle(NATIVE_CONNECTOR_CHANNELS.configure, (event, input: unknown) => apiResult(() => {
    assertTrusted(event, window);
    if (!dependencies.nativeConnectorService) throw new AevorenBotError("CONNECTOR_UNAVAILABLE");
    return dependencies.nativeConnectorService.configure(connectorConfigureSchema.parse(input));
  }));
  ipcMain.handle(IPC.productViewReply, (event, id: unknown, result: unknown) => apiResult(() => {
    assertTrusted(event, window);
    const parsed = z.object({ status: z.enum(["completed", "running", "waiting_user", "cancelled", "failed"]), result: z.unknown().optional(), reason: z.string().max(1_000).optional() }).strict().parse(result);
    return view.respond(z.string().uuid().parse(id), parsed);
  }));
  for (const method of ["status", "save", "permission", "control", "preview", "targets", "pairBrowser", "revokeBrowser", "openBrowserExtension"] as const) {
    ipcMain.handle(HOST_COMPUTER_CHANNELS[method], (event, input: unknown) => apiResult<unknown>(() => {
      assertTrusted(event, window);
      const service = dependencies.hostComputerService; if (!service) throw new AevorenBotError("BROWSER_UNAVAILABLE");
      if (method === "preview") return service.preview(browserScopeSchema.parse(input));
      if (method === "status" || method === "targets" || method === "pairBrowser" || method === "revokeBrowser" || method === "openBrowserExtension") return service[method]();
      return service[method](input);
    }));
  }
  for (const method of ["startupStatus", "cancelStartup", "openDocker"] as const) {
    ipcMain.handle(COMPUTER_UI_CHANNELS[method], (event, input: unknown) => apiResult<unknown>(async () => {
      assertTrusted(event, window);
      if (!dependencies.browserService) throw new AevorenBotError("BROWSER_UNAVAILABLE");
      if (method === "startupStatus" && !dependencies.browserService.startupStatus(browserScopeSchema.parse(input))) await dependencies.browserService.get(browserScopeSchema.parse(input));
      return method === "cancelStartup"
        ? dependencies.browserService.cancelStartup(browserScopeSchema.extend({ attemptId: z.string().uuid() }).parse(input))
        : dependencies.browserService[method](browserScopeSchema.parse(input));
    }));
  }
  for (const [channel, operation] of product.handlers) {
    ipcMain.handle(channel, (event, input: unknown) => apiResult(() => {
      assertTrusted(event, window);
      return operation(input);
    }));
  }
  ipcMain.on(IPC.appRendererReady, (event) => {
    if (isTrusted(event, window)) dependencies.rendererReady();
  });
  ipcMain.on(IPC.appConfirmClose, (event, canClose: unknown) => {
    if (isTrusted(event, window)) dependencies.confirmClose(canClose === true);
  });
  return product;
}
