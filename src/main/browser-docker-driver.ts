import { computerVolumes, volumeArgument } from "./computer-layout";
import { BROWSER_WORKER_VERSION } from "@shared/browser-contracts";
import { DockerCommandError, DockerDriver, type DockerContainer, type DockerImage } from "./docker-driver";

export const BROWSER_IMAGE_REF = `aevoren-browser-worker:${BROWSER_WORKER_VERSION}`;
export const BROWSER_MEMORY_MIB = 1536;
const EXECUTION_MEMORY_MIB = 768;
const ENGINE_MEMORY_RESERVE_MIB = 512;
const MIB = 1024 * 1024;
export class DockerMemoryError extends DockerCommandError {
  constructor(readonly requiredMiB: number, readonly availableMiB: number) { super("DOCKER_MEMORY_INSUFFICIENT", ""); }
}
function id(value: string): string {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) throw new DockerCommandError("DOCKER_ID_INVALID", "");
  return value;
}
function digest(value: string): string {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new DockerCommandError("DOCKER_IMAGE_INVALID", "");
  return value;
}

export class BrowserDockerDriver extends DockerDriver {
  private static admission: Promise<unknown> = Promise.resolve();
  private static readonly reservations = new Map<string, Map<symbol, () => string | undefined>>();

  /** Short allocation lock only; computers execute concurrently after admission. */
  async reserveComputer(environment: () => string | undefined, signal?: AbortSignal): Promise<() => Promise<void>> {
    const allocation = BrowserDockerDriver.admission.catch(() => undefined).then(async () => {
      signal?.throwIfAborted();
      const context = await this.localContext(signal);
      const total = JSON.parse((await this.command(["info", "--format", "{{json .}}"], { signal })).stdout).MemTotal as unknown;
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total <= 0) throw new DockerCommandError("DOCKER_MEMORY_UNAVAILABLE", "");
      const ids = (await this.command(["ps", "--quiet"], { signal })).stdout.trim().split(/\s+/u).filter(Boolean);
      if (ids.some(value => !/^[a-f0-9]{12,64}$/u.test(value))) throw new DockerCommandError("DOCKER_MEMORY_UNAVAILABLE", "");
      type Container = { Name: string; State: { Running: boolean }; HostConfig: { Memory: number }; Config: { Labels?: Record<string, string> } };
      const containers: Container[] = ids.length ? JSON.parse((await this.command(["container", "inspect", ...ids], { signal })).stdout) : [];
      if (!Array.isArray(containers) || containers.length !== ids.length || containers.some(value => !value.State || typeof value.State.Running !== "boolean" || typeof value.Name !== "string" || !value.Config || !Number.isSafeInteger(value.HostConfig?.Memory) || value.HostConfig.Memory < 0)) throw new DockerCommandError("DOCKER_MEMORY_UNAVAILABLE", "");
      const running = containers.filter(value => value.State.Running);
      const holders = BrowserDockerDriver.reservations.get(context) ?? new Map<symbol, () => string | undefined>();
      const key = Symbol();
      const demand = (leases: Map<symbol, () => string | undefined>): number => {
        const environments = new Map<string | symbol, string | undefined>();
        for (const [lease, getId] of leases) { const value = getId(); environments.set(value ?? lease, value); }
        let bytes = 0;
        for (const environmentId of environments.values()) {
          const owns = (role: string, name: string): boolean => environmentId !== undefined && running.some(value => {
            const labels = value.Config.Labels;
            const identity = role === "browser-environment" ? labels?.["io.aevoren.browser"] : environmentId;
            return identity !== undefined && value.Name === `/${name}-${identity}` && labels?.["io.aevoren.environment"] === environmentId && labels["io.aevoren.role"] === role;
          });
          if (!owns("execution-environment", "aevoren-execution")) bytes += EXECUTION_MEMORY_MIB * MIB;
          if (!owns("browser-environment", "aevoren-browser")) bytes += BROWSER_MEMORY_MIB * MIB;
        }
        return bytes;
      };
      const before = demand(holders), requested = new Map(holders); requested.set(key, environment);
      const additional = demand(requested) - before;
      if (additional > 0 && running.some(value => value.HostConfig.Memory === 0)) throw new DockerCommandError("DOCKER_MEMORY_UNAVAILABLE", "");
      const available = Math.max(0, total - ENGINE_MEMORY_RESERVE_MIB * MIB - before - running.reduce((sum, value) => sum + value.HostConfig.Memory, 0));
      if (additional > available) throw new DockerMemoryError(Math.ceil(additional / MIB), Math.floor(available / MIB));
      signal?.throwIfAborted();
      holders.set(key, environment); BrowserDockerDriver.reservations.set(context, holders);
      return () => {
        // Release after any in-flight inventory read. Otherwise a container can
        // appear between ps/inspect and release, escaping both the snapshot and lease.
        const cleanup = BrowserDockerDriver.admission.catch(() => undefined).then(() => {
          holders.delete(key); if (holders.size === 0) BrowserDockerDriver.reservations.delete(context);
        });
        BrowserDockerDriver.admission = cleanup; return cleanup;
      };
    });
    BrowserDockerDriver.admission = allocation.then(() => undefined, () => undefined);
    const release = await allocation;
    if (signal?.aborted) { await release(); signal.throwIfAborted(); }
    return release;
  }
  async inspectBrowserImage(ref = BROWSER_IMAGE_REF, signal?: AbortSignal): Promise<DockerImage | null> {
    if (ref !== BROWSER_IMAGE_REF) digest(ref);
    try {
      const image = JSON.parse((await this.command(["image", "inspect", ref, "--format", "{{json .}}"], { signal })).stdout);
      const labels = image.Config?.Labels ?? {};
      if (image.Os !== "linux" || !["arm64", "amd64"].includes(image.Architecture) || labels["io.aevoren.role"] !== "browser-worker"
        || !/^[a-f0-9]{64}$/.test(labels["io.aevoren.worker-bundle"] ?? "")) throw new DockerCommandError("DOCKER_IMAGE_INVALID", "");
      return { id: digest(image.Id), ref, platform: `linux/${image.Architecture}` as DockerImage["platform"], workerVersion: labels["io.aevoren.worker-version"], bundleSha256: labels["io.aevoren.worker-bundle"] };
    } catch (error) {
      if (error instanceof DockerCommandError && /No such image|not found/i.test(error.stderr)) return null;
      throw error;
    }
  }

  async initializeBrowser(contextPath: string, bundleSha256: string, signal?: AbortSignal): Promise<DockerImage> {
    if (!/^[a-f0-9]{64}$/.test(bundleSha256)) throw new DockerCommandError("DOCKER_IMAGE_INVALID", "");
    const probe = await this.probe(signal);
    if (probe.status !== "ready" || !probe.platform) throw new DockerCommandError("DOCKER_NOT_READY", "");
    await this.command(["build", "--platform", probe.platform, "--label", `io.aevoren.worker-bundle=${bundleSha256}`, "--tag", BROWSER_IMAGE_REF, contextPath], { signal, timeoutMs: 900_000 });
    const image = await this.inspectBrowserImage(BROWSER_IMAGE_REF, signal);
    if (!image || image.bundleSha256 !== bundleSha256 || image.workerVersion !== BROWSER_WORKER_VERSION || image.platform !== probe.platform) throw new DockerCommandError("DOCKER_IMAGE_INVALID", "");
    return image;
  }

  async inspectBrowser(browserId: string, environmentId: string, signal?: AbortSignal, legacy = false): Promise<DockerContainer | null> {
    const name = `aevoren-browser-${id(browserId)}${legacy ? "-layout1" : ""}`;
    try {
      const value = JSON.parse((await this.command(["container", "inspect", name, "--format", "{{json .}}"], { signal })).stdout);
      const labels = value.Config?.Labels ?? {};
      const layoutVersion = labels["io.aevoren.computer-layout"] === "2" ? 2 : 1;
      const expected = layoutVersion === 1 ? ["state", "profile", "downloads"].map(kind => ({ source: `aevoren-browser-${kind}-${browserId}`, target: `/var/lib/aevoren-browser-${kind}` }))
        : [{ source: `aevoren-computer-state-${environmentId}-v2`, target: "/var/lib/aevoren-browser-state" }, { source: `aevoren-work-${environmentId}`, target: "/workspace" }, ...Object.values(computerVolumes(environmentId))];
      const mounts = value.Mounts ?? [];
      if (labels["io.aevoren.role"] !== "browser-environment" || labels["io.aevoren.browser"] !== browserId || labels["io.aevoren.environment"] !== id(environmentId)
        || value.HostConfig?.Privileged || !value.HostConfig?.ReadonlyRootfs || !value.HostConfig?.CapDrop?.includes("ALL") || mounts.length !== expected.length
        || expected.some(item => !mounts.some((mount: { Type: string; Name: string; Destination: string }) => mount.Type === "volume"
          && mount.Name === item.source && mount.Destination === item.target))) throw new DockerCommandError("DOCKER_OWNERSHIP_INVALID", "");
      const bindings = value.NetworkSettings?.Ports?.["8081/tcp"] ?? [];
      if (bindings.some((binding: { HostIp: string; HostPort: string }) => binding.HostIp !== "127.0.0.1" || !/^\d+$/.test(binding.HostPort))) throw new DockerCommandError("DOCKER_OWNERSHIP_INVALID", "");
      return { id: value.Id, name, imageId: digest(value.Image), state: value.State.Status, workerPort: bindings[0] ? Number(bindings[0].HostPort) : null, oomKilled: Boolean(value.State.OOMKilled), layoutVersion };
    } catch (error) {
      if (error instanceof DockerCommandError && /No such container|not found/i.test(error.stderr)) return null;
      throw error;
    }
  }

  private async connectScope(environmentId: string, signal?: AbortSignal): Promise<string> {
    const network = `aevoren-scope-${id(environmentId)}`;
    try {
      const data = JSON.parse((await this.command(["network", "inspect", network, "--format", "{{json .}}"], { signal })).stdout);
      if (data.Labels?.["io.aevoren.environment"] !== environmentId) throw new DockerCommandError("DOCKER_OWNERSHIP_INVALID", "");
    } catch (error) {
      if (!(error instanceof DockerCommandError) || !/not found|No such network/i.test(error.stderr)) throw error;
      await this.command(["network", "create", "--label", `io.aevoren.environment=${environmentId}`, network], { signal });
    }
    if (!(await super.inspect(environmentId, signal))) throw new DockerCommandError("DOCKER_OWNERSHIP_INVALID", "");
    try { await this.command(["network", "connect", network, `aevoren-execution-${environmentId}`], { signal }); }
    catch (error) { if (!(error instanceof DockerCommandError) || !/already exists/i.test(error.stderr)) throw error; }
    return network;
  }

  private async executionAddress(environmentId: string, network: string, signal?: AbortSignal): Promise<string> {
    const networks = JSON.parse((await this.command(["container", "inspect", `aevoren-execution-${id(environmentId)}`, "--format", "{{json .NetworkSettings.Networks}}"], { signal })).stdout);
    const address: unknown = networks[network]?.IPAddress;
    if (typeof address !== "string" || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(address) || address.split(".").some(part => Number(part) > 255)) throw new DockerCommandError("DOCKER_OWNERSHIP_INVALID", "");
    return address;
  }

  async createBrowser(browserId: string, environmentId: string, image: DockerImage, token: string, signal?: AbortSignal): Promise<DockerContainer> {
    const release = await this.reserveComputer(() => environmentId, signal);
    try {
      const network = await this.connectScope(environmentId, signal);
      const address = await this.executionAddress(environmentId, network, signal);
      if (!/^[a-f0-9]{64}$/.test(token)) throw new DockerCommandError("DOCKER_ID_INVALID", "");
      const name = `aevoren-browser-${id(browserId)}`;
      await this.command(["run", "--detach", "--init", "--name", name, "--network", network,
        "--label", "io.aevoren.role=browser-environment", "--label", `io.aevoren.browser=${browserId}`, "--label", `io.aevoren.environment=${environmentId}`, "--label", "io.aevoren.computer-layout=2",
        "--read-only", "--memory", `${BROWSER_MEMORY_MIB}m`, "--pids-limit", "512", "--cpus", "1", "--cap-drop", "ALL",
        "--cap-add", "SETUID", "--cap-add", "SETGID", "--cap-add", "KILL", "--cap-add", "CHOWN", "--security-opt", "no-new-privileges",
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--publish", "127.0.0.1::8081",
        ...[{ source: `aevoren-computer-state-${environmentId}-v2`, target: "/var/lib/aevoren-browser-state" }, { source: `aevoren-work-${environmentId}`, target: "/workspace" }, ...Object.values(computerVolumes(environmentId))].flatMap(value => ["--mount", volumeArgument(value)]),
        "--env", "AEVOREN_COMPUTER_LAYOUT=2", "--env", "AEVOREN_BROWSER_TOKEN", "--env", `AEVOREN_PREVIEW_EXECUTION_IP=${address}`, "--env", `AEVOREN_BROWSER_ENVIRONMENT_ID=${environmentId}`, "--env", `AEVOREN_BROWSER_SESSION_ID=${browserId}`, digest(image.id)],
      { signal, env: { AEVOREN_BROWSER_TOKEN: token }, timeoutMs: 30_000 });
      const created = await this.inspectBrowser(browserId, environmentId, signal);
      if (!created?.workerPort) throw new DockerCommandError("DOCKER_OWNERSHIP_INVALID", "");
      return created;
    } finally { await release(); }
  }

  async archiveBrowser(browserId: string, environmentId: string, signal?: AbortSignal): Promise<void> {
    const current = await this.inspectBrowser(browserId, environmentId, signal);
    if (!current) return;
    if (await this.inspectBrowser(browserId, environmentId, signal, true)) throw new DockerCommandError("DOCKER_MIGRATION_CONFLICT", "");
    await this.stopBrowser(browserId, environmentId);
    await this.command(["rename", current.name, `${current.name}-layout1`], { signal });
  }
  async restoreBrowser(browserId: string, environmentId: string): Promise<DockerContainer | null> {
    const backup = await this.inspectBrowser(browserId, environmentId, undefined, true);
    if (!backup) {
      const current = await this.inspectBrowser(browserId, environmentId);
      if (current?.layoutVersion === 2) await this.stopBrowser(browserId, environmentId, true);
      return null;
    }
    await this.stopBrowser(browserId, environmentId, true);
    await this.command(["rename", backup.name, `aevoren-browser-${id(browserId)}`]);
    return this.startBrowser(browserId, environmentId);
  }
  async copyLegacyVolumes(browserId: string, environmentId: string, image: DockerImage, signal?: AbortSignal): Promise<void> {
    const targets = { state: `aevoren-computer-state-${id(environmentId)}-v2`, profile: computerVolumes(environmentId).profile.source, downloads: computerVolumes(environmentId).downloads.source };
    // Docker would otherwise create an empty source volume silently. Missing
    // legacy data is a failed migration, never a successful empty import.
    await this.command(["volume", "inspect", ...Object.keys(targets).map(kind => `aevoren-browser-${kind}-${id(browserId)}`)], { signal });
    for (const [kind, target] of Object.entries(targets)) {
      // Old container is stopped. Copy and verify inside a pinned trusted image;
      // there are no host paths, model credentials, network or Docker socket.
      await this.command(["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER", "--security-opt", "no-new-privileges",
        "--mount", `type=volume,source=aevoren-browser-${kind}-${id(browserId)},target=/source,readonly`,
        "--mount", `type=volume,source=${target},target=/target`, "--entrypoint", "/bin/sh", digest(image.id), "-c",
        'find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && cp -a /source/. /target/ && test "$(tar --sort=name -C /source -cf - . | sha256sum)" = "$(tar --sort=name -C /target -cf - . | sha256sum)"' +
        // The source is stopped and remains unchanged for rollback. These
        // process-local locks refer to its hostname, not a live target process.
        (kind === "profile" ? ' && rm -f -- /target/SingletonLock /target/SingletonCookie /target/SingletonSocket' : "")], { signal, timeoutMs: 120_000 });
    }
  }
  async startBrowser(browserId: string, environmentId: string, signal?: AbortSignal): Promise<DockerContainer> {
    const current = await this.inspectBrowser(browserId, environmentId, signal);
    if (!current) throw new DockerCommandError("DOCKER_OWNERSHIP_INVALID", "");
    if (current.state === "running") return current;
    const release = await this.reserveComputer(() => environmentId, signal);
    try {
      await this.connectScope(environmentId, signal);
      await this.command(["update", "--memory", `${BROWSER_MEMORY_MIB}m`, current.name], { signal });
      await this.command(["start", `aevoren-browser-${id(browserId)}`], { signal, timeoutMs: 30_000 });
      return (await this.inspectBrowser(browserId, environmentId, signal))!;
    } finally { await release(); }
  }
  async stopBrowser(browserId: string, environmentId: string, remove = false): Promise<void> {
    const current = await this.inspectBrowser(browserId, environmentId);
    if (!current) return;
    if (current.state === "running") await this.command(["stop", "--time", "10", current.name], { timeoutMs: 20_000 });
    if (remove) await this.command(["rm", current.name]);
  }
}
