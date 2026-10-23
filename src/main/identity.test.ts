import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const app = vi.hoisted(() => ({
  commandLine: { removeSwitch: vi.fn() },
  setName: vi.fn(),
  getPath: vi.fn(() => "/fixture/app-data"),
  setPath: vi.fn(),
  once: vi.fn(),
  setAboutPanelOptions: vi.fn(),
}));
const menu = vi.hoisted(() => ({ getApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() }));
vi.mock("electron", () => ({ app, Menu: menu }));
afterEach(() => { vi.resetAllMocks(); vi.resetModules(); vi.unstubAllEnvs(); });

it("retains the data and encryption identity during bootstrap, then displays Aevoren", async () => {
  await import("./identity");
  expect(app.setName.mock.calls).toEqual([["Aevoren Bot"]]);
  expect(app.getPath).toHaveBeenCalledWith("appData");
  expect(app.setPath).toHaveBeenCalledWith("userData", join("/fixture/app-data", "Aevoren Bot"));
  expect(app.setAboutPanelOptions).not.toHaveBeenCalled();
  expect(app.once).toHaveBeenCalledWith("ready", expect.any(Function));
  const onReady = app.once.mock.calls[0]![1] as () => void;
  onReady();
  expect(app.setName.mock.calls).toEqual([["Aevoren Bot"], ["Aevoren"]]);
  expect(app.setAboutPanelOptions).toHaveBeenCalledWith({ applicationName: "Aevoren" });
});

it.runIf(process.platform === "darwin")("refreshes the native application menu while preserving the other menus", async () => {
  const file = { label: "File" }, edit = { label: "Edit" };
  menu.getApplicationMenu.mockReturnValue({ items: [{ label: "Aevoren Bot" }, file, edit] });
  const rebuilt = { items: [] };
  menu.buildFromTemplate.mockReturnValue(rebuilt);
  await import("./identity");
  (app.once.mock.calls[0]![1] as () => void)();
  expect(menu.buildFromTemplate).toHaveBeenCalledWith([{ role: "appMenu" }, file, edit]);
  expect(menu.setApplicationMenu).toHaveBeenCalledWith(rebuilt);
});

it("does not change mock Keychain selection unless the existing system-storage flag is explicit", async () => {
  vi.stubEnv("AEVOREN_BOT_USE_SYSTEM_SAFE_STORAGE", "");
  await import("./identity");
  expect(app.commandLine.removeSwitch).not.toHaveBeenCalled();
  vi.resetModules();
  vi.stubEnv("AEVOREN_BOT_USE_SYSTEM_SAFE_STORAGE", "1");
  await import("./identity");
  expect(app.commandLine.removeSwitch).toHaveBeenCalledExactlyOnceWith("use-mock-keychain");
});
