import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openLocalDocker } from "./docker-desktop";

const calls = vi.hoisted(() => ({ probe: vi.fn(), context: vi.fn(), exists: vi.fn(), spawn: vi.fn(), open: vi.fn(), external: vi.fn() }));
vi.mock("./docker-driver", () => ({ DockerDriver: class { probe = calls.probe; localContext = calls.context; } }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(), existsSync: calls.exists }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: calls.spawn,
  execFile: (...args: unknown[]) => { calls.open(...args.slice(0, -1)); (args.at(-1) as (error: null, stdout: string) => void)(null, ""); } }));
vi.mock("electron", () => ({ shell: { openExternal: calls.external } }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  calls.probe.mockResolvedValue({ status: "stopped", reason: "Docker 未就绪" });
  calls.context.mockResolvedValue("colima");
  calls.exists.mockImplementation((path: string) => path === "/opt/homebrew/bin/colima");
  calls.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    queueMicrotask(() => child.emit("spawn")); return child;
  });
});
afterEach(() => { Object.defineProperty(process, "platform", platform); });

it("leaves an already-ready local engine and its context alone", async () => {
  calls.probe.mockResolvedValue({ status: "ready" });
  await openLocalDocker();
  expect(calls.spawn).not.toHaveBeenCalled(); expect(calls.open).not.toHaveBeenCalled(); expect(calls.external).not.toHaveBeenCalled();
});
it.each([["colima", "default"], ["colima-work", "work"]])("starts selected Colima context %s without activating another context", async (context, profile) => {
  calls.context.mockResolvedValue(context);
  calls.exists.mockImplementation((path: string) => ["/opt/homebrew/bin/colima", "/Applications/Docker.app"].includes(path));
  await openLocalDocker();
  expect(calls.spawn).toHaveBeenCalledWith("/opt/homebrew/bin/colima", ["start", "--profile", profile, "--activate=false"], expect.objectContaining({ shell: false, detached: true, stdio: "ignore" }));
  expect(calls.open).not.toHaveBeenCalled(); expect(calls.external).not.toHaveBeenCalled();
});
it("does not redirect an installed CLI runtime to a Desktop download", async () => {
  calls.exists.mockReturnValue(false);
  await expect(openLocalDocker()).rejects.toThrow(/Colima/);
  expect(calls.spawn).not.toHaveBeenCalled(); expect(calls.external).not.toHaveBeenCalled();
});
it("does not replace another selected local runtime with Desktop", async () => {
  calls.context.mockResolvedValue("podman-machine-default"); calls.exists.mockReturnValue(true);
  await expect(openLocalDocker()).rejects.toThrow(/当前/);
  expect(calls.spawn).not.toHaveBeenCalled(); expect(calls.open).not.toHaveBeenCalled(); expect(calls.external).not.toHaveBeenCalled();
});
it("rejects unsupported remote or non-Linux engines before launching a runtime", async () => {
  calls.probe.mockResolvedValue({ status: "unsupported", reason: "仅支持本机 Linux Docker" });
  await expect(openLocalDocker()).rejects.toThrow(/本机/);
  expect(calls.spawn).not.toHaveBeenCalled(); expect(calls.external).not.toHaveBeenCalled();
});
it("retains explicit Docker Desktop startup on macOS", async () => {
  calls.context.mockResolvedValue("desktop-linux"); calls.exists.mockImplementation((path: string) => path === "/Applications/Docker.app");
  await openLocalDocker();
  expect(calls.open).toHaveBeenCalledWith("/usr/bin/open", ["-g", "-a", "/Applications/Docker.app"]);
  expect(calls.spawn).not.toHaveBeenCalled(); expect(calls.external).not.toHaveBeenCalled();
});
it("retains the fixed Windows Desktop executable", async () => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" }); calls.context.mockResolvedValue("default"); calls.exists.mockReturnValue(true);
  await openLocalDocker();
  expect(calls.spawn).toHaveBeenCalledWith(expect.stringMatching(/Docker Desktop\.exe$/), [], expect.objectContaining({ detached: true, windowsHide: true }));
  expect(calls.external).not.toHaveBeenCalled();
});
it("reports Colima launch errors without claiming engine readiness or opening Desktop", async () => {
  calls.spawn.mockImplementation(() => { const child = new EventEmitter(); queueMicrotask(() => child.emit("error", new Error("Colima launch failed"))); return child; });
  await expect(openLocalDocker()).rejects.toThrow("Colima launch failed");
  expect(calls.external).not.toHaveBeenCalled();
});

it("reports a missing Docker CLI when Colima is already installed", async () => {
  calls.probe.mockResolvedValue({ status: "missing" });
  await expect(openLocalDocker()).rejects.toThrow(/Docker CLI/);
  expect(calls.spawn).not.toHaveBeenCalled(); expect(calls.external).not.toHaveBeenCalled();
});
