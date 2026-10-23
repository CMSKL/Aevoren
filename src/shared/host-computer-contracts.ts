import type { ApiResult } from "./contracts";
import type { BrowserScope } from "./browser-contracts";
import type { HostComputerTarget, HostBrowserPairing } from "./host-computer-targets";
export type { HostComputerTarget, HostBrowserPairing } from "./host-computer-targets";

export type ComputerTarget = "builtin" | "mac";
export type HostComputerConfiguration = { version: number; target: ComputerTarget; enabled: boolean; hostTarget: HostComputerTarget | null };
export type HostComputerStatus = { configuration: HostComputerConfiguration; supported: boolean; helperAvailable: boolean;
  screenPermission: string; accessibility: boolean; browserConnected: boolean; owner: "ai" | "user"; epoch: number; busy: boolean };
export type HostComputerApi = {
  status(): Promise<ApiResult<HostComputerStatus>>;
  save(input: HostComputerConfiguration): Promise<ApiResult<HostComputerStatus>>;
  permission(input: { kind: "screen" | "accessibility" }): Promise<ApiResult<void>>;
  control(input: { owner: "ai" | "user"; expectedEpoch: number }): Promise<ApiResult<HostComputerStatus>>;
  preview(input: BrowserScope): Promise<ApiResult<{ dataUrl: string; capturedAt: string }>>;
  targets(): Promise<ApiResult<HostComputerTarget[]>>;
  pairBrowser(): Promise<ApiResult<HostBrowserPairing>>;
  revokeBrowser(): Promise<ApiResult<void>>;
  openBrowserExtension(): Promise<ApiResult<void>>;
};
export const HOST_COMPUTER_CHANNELS = { status: "hostComputer:status", save: "hostComputer:save", permission: "hostComputer:permission", control: "hostComputer:control", preview: "hostComputer:preview", targets: "hostComputer:targets", pairBrowser: "hostComputer:pairBrowser", revokeBrowser: "hostComputer:revokeBrowser", openBrowserExtension: "hostComputer:openBrowserExtension" } as const;
