import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { BrowserDockerDriver } from "./browser-docker-driver";
import { DockerCommandError, type DockerCommandRunner } from "./docker-driver";
import { computerVolumes } from "./computer-layout";

const MiB = 1024 * 1024;
type Container = { Id: string; Name: string; Image: string; State: { Running: boolean; Status: string; OOMKilled: boolean };
  Config: { Labels: Record<string, string> }; HostConfig: { Memory: number; ReadonlyRootfs: boolean; CapDrop: string[] };
  Mounts: { Type: string; Name: string; Destination: string }[]; NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[]>; Networks: Record<string, { IPAddress: string }> } };
const image = { id: `sha256:${"a".repeat(64)}`, ref: "fixture", platform: "linux/arm64" as const, workerVersion: "1.2.0", bundleSha256: "b".repeat(64) };
function fixture(totalMiB: number) {
  const context = `memory-test-${randomUUID()}`, entries = new Map<string, Container>(), runs: string[][] = [];
  let inventoryBarrier: (() => Promise<void>) | undefined;
  const scopes = Array.from({ length: 6 }, () => ({ environmentId: randomUUID(), browserId: randomUUID() }));
  const base = (name: string, environmentId: string): Container => ({ Id: randomUUID().replaceAll("-", "").repeat(2), Name: `/${name}`, Image: image.id, State: { Running: true, Status: "running", OOMKilled: false },
    Config: { Labels: { "io.aevoren.environment": environmentId, "io.aevoren.computer-layout": "2" } },
    HostConfig: { Memory: 768 * MiB, ReadonlyRootfs: true, CapDrop: ["ALL"] }, Mounts: [], NetworkSettings: { Ports: {}, Networks: {} } });
  const addExecution = (environmentId: string) => {
    const name = `aevoren-execution-${environmentId}`, entry = base(name, environmentId);
    entry.Config.Labels["io.aevoren.role"] = "execution-environment";
    entry.Mounts = [{ source: `aevoren-work-${environmentId}`, target: "/workspace" }, { source: `aevoren-state-${environmentId}`, target: "/var/lib/aevoren" },
      ...[computerVolumes(environmentId).home, computerVolumes(environmentId).profile, computerVolumes(environmentId).downloads]]
      .map(({ source, target }) => ({ Type: "volume", Name: source, Destination: target }));
    entry.NetworkSettings.Ports = { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "43117" }] };
    entry.NetworkSettings.Networks = { [`aevoren-scope-${environmentId}`]: { IPAddress: "172.19.0.2" } };
    entries.set(name, entry);
  };
  const runner: DockerCommandRunner = async args => {
    if (args[0] === "context") return { stdout: args[1] === "show" ? context : JSON.stringify("unix:///fixture/docker.sock"), stderr: "" };
    const command = args.slice(2), result = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "" });
    if (command[0] === "info") return result({ MemTotal: totalMiB * MiB });
    if (command[0] === "ps") {
      const snapshot = { stdout: [...entries].filter(([, entry]) => entry.State.Running).map(([, entry]) => entry.Id).join("\n"), stderr: "" };
      const barrier = inventoryBarrier; inventoryBarrier = undefined; await barrier?.(); return snapshot;
    }
    if (command[0] === "network") return result({ Labels: { "io.aevoren.environment": command[2]!.slice("aevoren-scope-".length) } });
    if (command[0] === "container" && command[1] === "inspect") {
      const names = command.slice(2, command.includes("--format") ? command.indexOf("--format") : undefined), values = names.map(name => entries.get(name) ?? [...entries.values()].find(value => value.Id === name));
      if (values.some(value => !value)) throw new DockerCommandError("DOCKER_COMMAND_FAILED", "No such container");
      if (!command.includes("--format")) return result(values);
      return result(command.at(-1)!.includes("Networks") ? values[0]!.NetworkSettings.Networks : values[0]);
    }
    if (command[0] === "run") {
      runs.push(command);
      const name = command[command.indexOf("--name") + 1]!, environmentId = command[command.indexOf("--network") + 1]!.slice("aevoren-scope-".length);
      const entry = base(name, environmentId);
      for (const [index, value] of command.entries()) if (value === "--label") { const [key, val] = command[index + 1]!.split("="); entry.Config.Labels[key!] = val!; }
      entry.HostConfig.Memory = Number.parseInt(command[command.indexOf("--memory") + 1]!) * MiB;
      entry.Mounts = command.flatMap((value, index) => value === "--mount" ? [Object.fromEntries(command[index + 1]!.split(",").map(pair => pair.split("=")))] : [])
        .map(value => ({ Type: value.type, Name: value.source, Destination: value.target }));
      entry.NetworkSettings.Ports = { "8081/tcp": [{ HostIp: "127.0.0.1", HostPort: "43118" }] };
      entries.set(name, entry); return { stdout: name, stderr: "" };
    }
    if (command[0] === "update") { const entry = entries.get(command.at(-1)!)!; entry.HostConfig.Memory = Number.parseInt(command[command.indexOf("--memory") + 1]!) * MiB; return result({}); }
    if (command[0] === "start") { const entry = entries.get(command[1]!)!; entry.State.Running = true; entry.State.Status = "running"; return result({}); }
    throw new Error(`Unexpected fixture command: ${command[0]}`);
  };
  return { scopes, entries, runs, addExecution, holdInventory(value: () => Promise<void>) { inventoryBarrier = value; }, driver: new BrowserDockerDriver(runner), anotherDriver: () => new BrowserDockerDriver(runner) };
}

it("budgets the full desktop with margin above the measured 1284 MiB three-site peak while preserving other sandbox limits", async () => {
  const f = fixture(16_384), scope = f.scopes[0]!; f.addExecution(scope.environmentId);
  await f.driver.createBrowser(scope.browserId, scope.environmentId, image, "c".repeat(64));
  const args = f.runs[0]!;
  expect(Number.parseInt(args[args.indexOf("--memory") + 1]!) * MiB).toBeGreaterThan(1_346_387_968 * 1.15);
  expect(args[args.indexOf("--pids-limit") + 1]).toBe("512");
  expect(args[args.indexOf("--cpus") + 1]).toBe("1");
  expect(args).toContain("--read-only"); expect(args).toContain("no-new-privileges");
});
it("refuses a desktop before creating it when the real engine budget cannot fit its companion", async () => {
  const f = fixture(2048), scope = f.scopes[0]!; f.addExecution(scope.environmentId);
  await expect(f.driver.createBrowser(scope.browserId, scope.environmentId, image, "c".repeat(64))).rejects.toMatchObject({ code: "DOCKER_MEMORY_INSUFFICIENT" });
  expect(f.runs).toEqual([]);
});
it("accounts for parallel starts across drivers without serializing their running tasks", async () => {
  const f = fixture(16_384); f.scopes.forEach(scope => f.addExecution(scope.environmentId));
  await Promise.all(f.scopes.map(scope => f.anotherDriver().createBrowser(scope.browserId, scope.environmentId, image, "c".repeat(64))));
  expect(f.runs).toHaveLength(6);
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(accept => { resolve = accept; }); return { promise, resolve }; }

it("does not lose a pending lease when its container appears after an inventory snapshot", async () => {
  const f = fixture(4096), [first, second] = f.scopes;
  f.addExecution(first!.environmentId); f.addExecution(second!.environmentId);
  const admitted = deferred(), progress = deferred(), inventory = deferred(), inspect = deferred(), released = deferred();
  const reserve = f.driver.reserveComputer.bind(f.driver);
  vi.spyOn(f.driver, "reserveComputer").mockImplementation(async (...args) => {
    const release = await reserve(...args); admitted.resolve(); await progress.promise;
    return async () => { released.resolve(); await release(); };
  });
  const one = f.driver.createBrowser(first!.browserId, first!.environmentId, image, "c".repeat(64));
  await admitted.promise;
  f.holdInventory(async () => { inventory.resolve(); await inspect.promise; });
  const two = f.anotherDriver().createBrowser(second!.browserId, second!.environmentId, image, "c".repeat(64));
  const rejected = expect(two).rejects.toMatchObject({ code: "DOCKER_MEMORY_INSUFFICIENT" });
  await inventory.promise; progress.resolve(); await released.promise; inspect.resolve();
  await one; await rejected;
  expect(f.runs).toHaveLength(1);
});
it("releases a cancelled reservation before admitting the next computer", async () => {
  const f = fixture(4096), scope = f.scopes[0]!; f.addExecution(scope.environmentId);
  const controller = new AbortController(); controller.abort();
  await expect(f.driver.createBrowser(scope.browserId, scope.environmentId, image, "c".repeat(64), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(f.runs).toEqual([]);
  await f.driver.createBrowser(scope.browserId, scope.environmentId, image, "c".repeat(64));
  expect(f.runs).toHaveLength(1);
});
it("keeps a running desktop unchanged and applies the new budget only after it is stopped", async () => {
  const f = fixture(4096), scope = f.scopes[0]!; f.addExecution(scope.environmentId);
  await f.driver.createBrowser(scope.browserId, scope.environmentId, image, "c".repeat(64));
  const desktop = f.entries.get(`aevoren-browser-${scope.browserId}`)!; desktop.HostConfig.Memory = 768 * MiB;
  await f.driver.startBrowser(scope.browserId, scope.environmentId);
  expect(desktop.HostConfig.Memory).toBe(768 * MiB);
  desktop.State = { ...desktop.State, Running: false, Status: "exited" };
  await f.driver.startBrowser(scope.browserId, scope.environmentId);
  expect(desktop.HostConfig.Memory).toBe(1536 * MiB);
  expect(f.runs).toHaveLength(1);
});
it("does not assume unbounded containers are free or silently reduce their limits", async () => {
  const f = fixture(4096), scope = f.scopes[0]!; f.addExecution(scope.environmentId);
  const execution = f.entries.get(`aevoren-execution-${scope.environmentId}`)!; execution.HostConfig.Memory = 0;
  await expect(f.driver.createBrowser(scope.browserId, scope.environmentId, image, "c".repeat(64))).rejects.toMatchObject({ code: "DOCKER_MEMORY_UNAVAILABLE" });
  expect(execution.HostConfig.Memory).toBe(0); expect(f.runs).toEqual([]);
});
