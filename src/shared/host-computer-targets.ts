export type HostAppTarget = {
  kind: "app";
  pid: number;
  startedAt: number;
  windowId: number;
  appName: string;
  title: string;
};
export type HostBrowserTarget = {
  kind: "browser";
  connectionId: string;
  tabId: number;
  title: string;
  url: string;
};
export type HostComputerTarget = HostAppTarget | HostBrowserTarget;
export type HostAppContext = {
  kind: "app";
  target: HostAppTarget;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type HostBrowserContext = {
  kind: "browser";
  target: HostBrowserTarget;
  documentId: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type HostInputContext = HostAppContext | HostBrowserContext;
export type HostCapture = { bytes: Uint8Array; width: number; height: number; context: HostInputContext };
export type HostBrowserPairing = { endpoint: string; code: string; expiresAt: string };
