import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, fetch as pinnedFetch } from "undici";
import type { BrowserScope } from "@shared/browser-contracts";
import { applicationInstallSchema, applicationLaunchSchema, type Application, type ApplicationInstall, type ApplicationLaunch, type ApplicationProcess } from "@shared/application-contracts";
import type { AppRepository } from "./database";
import type { BrowserService } from "./browser-service";
import type { EnvironmentService } from "./environment-service";
import { DockerCommandError } from "./docker-driver";
import { BrowserDockerDriver } from "./browser-docker-driver";
import { computerVolumes, volumeArgument } from "./computer-layout";
import { createPinnedLookup, resolveSafeNetworkUrl } from "./network-security";
import { applicationDockerfile } from "./application-build";
import { AevorenBotError, asAppError } from "./errors";

const builtins = [ { id: "terminal", name: "终端", executable: "/usr/bin/xterm" }, { id: "files", name: "文件", executable: "/usr/bin/pcmanfm" }, { id: "editor", name: "文本编辑", executable: "/usr/bin/mousepad" } ];
const imageId = (value: string): string => { if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new AevorenBotError("ENVIRONMENT_IMAGE_INVALID"); return value; };
type ApplicationContainer = {
  Config?: { User?: string; Labels?: Record<string, string> }; HostConfig?: { Privileged?: boolean; ReadonlyRootfs?: boolean; CapDrop?: string[] };
  Mounts?: { Type: string; Name: string; Destination: string }[];
};

export class ApplicationDockerDriver extends BrowserDockerDriver {
  applicationCommand(args: string[], options?: { signal?: AbortSignal; timeoutMs?: number }) { return this.command(args, options); }
}

export class ApplicationService {
  private readonly builds = new Map<string, AbortController>();
  private readonly pending = new Set<Promise<void>>();
  private readonly buildQueues = new Map<string, Promise<void>>();
  private readonly launches = new Map<Promise<ApplicationProcess>, string>();
  private readonly closing = new AbortController();
  constructor(private readonly repository: AppRepository, private readonly browser: BrowserService, private readonly environments: EnvironmentService,
    private readonly docker = new ApplicationDockerDriver()) { repository.applications.recover(); }

  private assertAI(scope: BrowserScope): void {
    this.repository.assertSessionExecutor(scope.sessionId, scope.executorBotId);
    if (this.repository.browsers.view(scope)?.owner === "user") throw new AevorenBotError("COMPUTER_USER_CONTROLLED");
  }
  private idle(scope: BrowserScope): boolean {
    const environment = this.repository.environments.get(scope);
    return this.repository.browsers.view(scope)?.owner !== "user"
      && !this.repository.environments.listExecutions(scope).some(job => ["running", "unknown"].includes(job.state))
      && (!environment || !this.repository.applications.launches(environment.id).some(app => ["running", "paused", "unknown", "starting"].includes(app.state)));
  }
  list(scope: BrowserScope): Application[] {
    this.repository.assertSessionExecutor(scope.sessionId, scope.executorBotId);
    const record = this.repository.browsers.getInternal(scope);
    const at = record?.createdAt ?? new Date().toISOString();
    const installed = this.repository.applications.list(scope).map(value => value.state === "pending" && this.idle(scope) ? this.repository.applications.save(scope, { ...value, state: "installed" }) : value);
    const image = installed.find(app => app.state === "installed" && app.imageDigest)?.imageDigest ?? record?.imageDigest ?? null;
    const defaults: Application[] = record?.workerVersion === "1.2.0" ? builtins.map(value => ({ ...value, state: "installed", source: null, imageDigest: image, baseImageDigest: record.imageDigest, platform: record.platform ?? "", packageVersions: null, error: null, createdAt: at, updatedAt: at })) : [];
    return [...defaults, ...installed];
  }
  async install(raw: ApplicationInstall, ai = false): Promise<Application> {
    const input = applicationInstallSchema.parse(raw);
    if (ai) this.assertAI(input); else this.repository.assertSessionExecutor(input.sessionId, input.executorBotId);
    this.closing.signal.throwIfAborted();
    const environment = await this.environments.get({ sessionId: input.sessionId, executorBotId: input.executorBotId });
    if (!environment) throw new AevorenBotError("ENVIRONMENT_NOT_FOUND");
    const { application, reused } = this.repository.applications.create(input, environment.platform);
    if (!reused) {
      const key = `${input.sessionId}:${input.executorBotId}`, previous = this.buildQueues.get(key) ?? Promise.resolve();
      const pending = previous.catch(() => undefined).then(() => this.repository.applications.list(input).find(value => value.id === application.id)?.state === "building" ? this.build(input, application) : undefined).finally(() => {
        this.pending.delete(pending); if (this.buildQueues.get(key) === pending) this.buildQueues.delete(key);
      });
      this.buildQueues.set(key, pending);
      this.pending.add(pending); void pending.catch(() => undefined);
    }
    return application;
  }
  private async bytes(url: string, signal: AbortSignal): Promise<Buffer> {
    const target = await resolveSafeNetworkUrl(url), dispatcher = new Agent({ connect: { lookup: createPinnedLookup(target) } });
    try {
      const response = await pinnedFetch(target.url, { redirect: "error", dispatcher, signal });
      if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 256 * 1_024 * 1_024) { await response.body?.cancel(); throw new AevorenBotError("NETWORK_TOOL_RESPONSE_INVALID"); }
      const parts: Buffer[] = []; let size = 0;
      for await (const value of response.body!) { signal.throwIfAborted(); size += value.length; if (size > 256 * 1_024 * 1_024) throw new AevorenBotError("NETWORK_TOOL_RESPONSE_INVALID"); parts.push(Buffer.from(value)); }
      return Buffer.concat(parts);
    } finally { await dispatcher.close(); }
  }
  private async build(scope: BrowserScope, original: Application): Promise<void> {
    const controller = new AbortController(); this.builds.set(original.id, controller);
    const signal = AbortSignal.any([controller.signal, this.closing.signal, AbortSignal.timeout(15 * 60_000)]);
    let directory: string | undefined;
    let application = original;
    try {
      directory = await mkdtemp(join(tmpdir(), "aevoren-application-build-"));
      const source = application.source!;
      const record = this.repository.browsers.getInternal(scope);
      const prior = this.repository.applications.list(scope).find(app => ["installed", "pending"].includes(app.state) && app.imageDigest);
      const base = record?.workerVersion === "1.2.0" && record.imageDigest ? await this.docker.inspectBrowserImage(prior?.imageDigest ?? record.imageDigest, signal) : null;
      if (!base) throw new AevorenBotError("ENVIRONMENT_IMAGE_INVALID");
      if (base.platform !== application.platform) throw new AevorenBotError("ENVIRONMENT_IMAGE_INVALID", "应用镜像与当前 Linux 架构不一致。");
      if (source.kind !== "apt") {
        const bytes = await this.bytes(source.url, signal);
        if (createHash("sha256").update(bytes).digest("hex") !== source.sha256) throw new AevorenBotError("ENVIRONMENT_IMAGE_INVALID", "安装文件摘要不一致。");
        if (source.kind !== "deb" && bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) {
          const machine = bytes.length >= 20 ? bytes.readUInt16LE(18) : 0;
          if (machine !== (application.platform === "linux/arm64" ? 183 : 62)) throw new AevorenBotError("ENVIRONMENT_IMAGE_INVALID", "安装文件架构不匹配。");
        }
        await writeFile(join(directory, "payload"), bytes, { mode: 0o600, signal });
      }
      // BuildKit treats FROM sha256:<local image ID> as a registry tag. Give the
      // already verified local image a unique build-only reference instead.
      const baseRef = `aevoren-application-base:${application.id}`;
      await this.docker.applicationCommand(["tag", imageId(base.id), baseRef], { signal });
      await writeFile(join(directory, "Dockerfile"), applicationDockerfile(baseRef, source, application.id), { mode: 0o600, signal });
      const tag = `aevoren-application:${application.id}`;
      await this.docker.applicationCommand(["build", "--platform", application.platform, "--tag", tag, directory], { signal, timeoutMs: 900_000 });
      const image = JSON.parse((await this.docker.applicationCommand(["image", "inspect", tag, "--format", "{{json .}}"], { signal })).stdout);
      if (image.Config?.Labels?.["io.aevoren.application-install"] !== application.id || `linux/${image.Architecture}` !== application.platform) throw new AevorenBotError("ENVIRONMENT_IMAGE_INVALID");
      const versions = await this.docker.applicationCommand(["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--entrypoint", "/usr/bin/dpkg-query", imageId(image.Id), "-W", "-f=${Package}=${Version}\\n"], { signal });
      application = { ...application, imageDigest: imageId(image.Id), baseImageDigest: base.id, packageVersions: versions.stdout,
        executable: source.kind === "appimage" ? "/opt/aevoren-application/squashfs-root/AppRun" : source.executable, state: this.idle(scope) ? "installed" : "pending", error: null };
      this.repository.applications.save(scope, application);
    } catch (error) {
      this.repository.applications.save(scope, { ...application, state: signal.aborted ? "interrupted" : "failed", error: error instanceof AevorenBotError ? `${error.code}: ${asAppError(error).safeMessage}` : "应用构建失败，原电脑保持可用。" });
    } finally { this.builds.delete(original.id); if (directory) await rm(directory, { recursive: true, force: true }); }
  }
  async launch(raw: ApplicationLaunch, ai = false, taskId?: string): Promise<ApplicationProcess> {
    const parsed = applicationLaunchSchema.parse(raw);
    if (taskId) this.repository.computerTasks.get({ ...parsed, id: taskId });
    const pending = this.launchPrepared(parsed, ai, taskId), key = `${parsed.sessionId}:${parsed.executorBotId}`;
    this.launches.set(pending, key);
    try { return await pending; } finally { this.launches.delete(pending); }
  }
  private async launchPrepared(raw: ApplicationLaunch, ai: boolean, taskId?: string): Promise<ApplicationProcess> {
    const input = applicationLaunchSchema.parse(raw), scope = { sessionId: input.sessionId, executorBotId: input.executorBotId };
    if (ai) this.assertAI(scope); else this.repository.assertSessionExecutor(scope.sessionId, scope.executorBotId);
    await this.browser.view(scope, { actor: ai ? "ai" : "user" });
    const available = this.list(scope), application = available.find(value => value.id === input.id);
    if (!application || application.state !== "installed" || !application.imageDigest) throw new AevorenBotError("INVALID_REQUEST", "应用尚未安装完成，或等待电脑空闲后应用。");
    const activeImage = available.find(value => value.id === "terminal")?.imageDigest ?? application.imageDigest;
    const environment = this.repository.environments.get(scope)!;
    const browser = this.repository.browsers.get(scope)!;
    const container = await this.docker.inspectBrowser(browser.id, environment.id);
    if (container?.state !== "running" || container.layoutVersion !== 2) throw new AevorenBotError("BROWSER_UNAVAILABLE");
    const seed = createHash("sha256").update(JSON.stringify([scope, input.clientNonce])).digest("hex");
    const launchId = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4${seed.slice(13, 16)}-8${seed.slice(17, 20)}-${seed.slice(20, 32)}`;
    const name = `aevoren-application-${launchId}`;
    const volumes = computerVolumes(environment.id), mounts = [{ source: `aevoren-work-${environment.id}`, target: "/workspace" }, ...Object.values(volumes)];
    const prior = this.repository.applications.launchRecord(environment.id, launchId, input, ai, activeImage, taskId);
    if (!prior.reused) {
      try {
        await this.docker.applicationCommand(["run", "--detach", "--init", "--name", name, "--network", `aevoren-scope-${environment.id}`, "--read-only", "--user", "1000:1000", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "768m", "--pids-limit", "256", "--cpus", "1", "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m",
          "--label", "io.aevoren.role=computer-application", "--label", `io.aevoren.environment=${environment.id}`,
          ...mounts.flatMap(value => ["--mount", volumeArgument(value)]), "--env", "DISPLAY=:99", "--env", "HOME=/home/aevoren", "--env", "LANG=C.UTF-8", "--workdir", "/workspace", "--entrypoint", application.executable, imageId(activeImage), ...input.args]);
      } catch (error) { this.repository.applications.finishLaunch(environment.id, launchId, "unknown"); throw error; }
    }
    try {
      const actual = JSON.parse((await this.docker.applicationCommand(["container", "inspect", name, "--format", "{{json .}}"])).stdout);
      if (actual.Config?.Labels?.["io.aevoren.role"] !== "computer-application" || actual.Config.Labels["io.aevoren.environment"] !== environment.id || actual.Image !== prior.imageDigest
        || actual.HostConfig?.Privileged || !actual.HostConfig?.ReadonlyRootfs || actual.Config?.User !== "1000:1000" || !actual.HostConfig.CapDrop?.includes("ALL")
        || actual.Mounts?.length !== mounts.length || mounts.some(value => !actual.Mounts.some((mount: { Type: string; Name: string; Destination: string }) => mount.Type === "volume" && mount.Name === value.source && mount.Destination === value.target))) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
      if (ai) this.assertAI(scope);
      this.repository.applications.finishLaunch(environment.id, launchId, actual.State.Status);
      return { id: launchId, applicationId: application.id, state: actual.State.Status, exitCode: actual.State.Status === "running" ? null : actual.State.ExitCode };
    } catch { throw new AevorenBotError("TOOL_STATE_INVALID", "应用启动结果尚未确认；没有重复启动，请检查电脑窗口。"); }
  }
  async stopScope(scope: BrowserScope, remove: boolean, taskId?: string): Promise<void> {
    const environment = this.repository.environments.get(scope);
    if (!environment) return;
    for (const record of this.repository.applications.launches(environment.id).filter(record => record.state !== "removed" && (!taskId || record.taskId === taskId))) {
      const name = `aevoren-application-${record.id}`;
      let actual;
      try { actual = JSON.parse((await this.docker.applicationCommand(["container", "inspect", name, "--format", "{{json .}}"])).stdout); }
      catch (error) {
        if (error instanceof DockerCommandError && /No such container|not found/i.test(error.stderr)) { this.repository.applications.finishLaunch(environment.id, record.id, "removed"); continue; }
        throw error;
      }
      this.assertContainer(actual, environment.id);
      if (actual.State.Status === "paused") {
        // Do not briefly resume automation while a person owns the computer.
        await this.docker.applicationCommand(["rm", "--force", name]);
        this.repository.applications.finishLaunch(environment.id, record.id, "removed"); continue;
      }
      if (["running", "paused"].includes(actual.State.Status)) await this.docker.applicationCommand(["stop", "--time", "10", name], { timeoutMs: 20_000 });
      if (remove) await this.docker.applicationCommand(["rm", name]);
      this.repository.applications.finishLaunch(environment.id, record.id, remove ? "removed" : "exited");
    }
  }
  private assertContainer(actual: ApplicationContainer, environmentId: string): void {
    const mounts = [{ source: `aevoren-work-${environmentId}`, target: "/workspace" }, ...Object.values(computerVolumes(environmentId))];
    const actualMounts = actual.Mounts ?? [];
    if (actual.Config?.Labels?.["io.aevoren.role"] !== "computer-application" || actual.Config.Labels["io.aevoren.environment"] !== environmentId || actual.Config.User !== "1000:1000"
      || actual.HostConfig?.Privileged || !actual.HostConfig?.ReadonlyRootfs || !actual.HostConfig?.CapDrop?.includes("ALL")
      || actualMounts.length !== mounts.length || mounts.some(value => !actualMounts.some(mount => mount.Type === "volume" && mount.Name === value.source && mount.Destination === value.target))) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
  }
  async pauseAutomation(scope: BrowserScope, paused: boolean): Promise<void> {
    await Promise.allSettled([...this.launches].filter(([, key]) => key === `${scope.sessionId}:${scope.executorBotId}`).map(([pending]) => pending));
    const environment = this.repository.environments.get(scope);
    if (!environment) return;
    for (const record of this.repository.applications.launches(environment.id).filter(record => record.ai && record.state !== "removed")) {
      const name = `aevoren-application-${record.id}`;
      const actual = JSON.parse((await this.docker.applicationCommand(["container", "inspect", name, "--format", "{{json .}}"])).stdout);
      this.assertContainer(actual, environment.id);
      if (actual.State.Status === (paused ? "running" : "paused")) await this.docker.applicationCommand([paused ? "pause" : "unpause", name]);
      const confirmed = JSON.parse((await this.docker.applicationCommand(["container", "inspect", name, "--format", "{{json .State}}"])).stdout);
      if (["running", "paused"].includes(confirmed.Status) && confirmed.Status !== (paused ? "paused" : "running")) throw new AevorenBotError("TOOL_STATE_INVALID");
    }
  }
  cancelBuild(scope: BrowserScope, id: string): void {
    this.repository.assertSessionExecutor(scope.sessionId, scope.executorBotId);
    if (!this.repository.applications.list(scope).some(application => application.id === id)) throw new AevorenBotError("INVALID_REQUEST");
    const controller = this.builds.get(id);
    if (controller) controller.abort();
    else {
      const application = this.repository.applications.list(scope).find(application => application.id === id)!;
      if (application.state === "building") this.repository.applications.save(scope, { ...application, state: "interrupted", error: "TOOL_EXECUTION_CANCELLED" });
    }
  }
  async close(): Promise<void> { this.closing.abort(); await Promise.allSettled([...this.pending, ...this.launches.keys()]); }
}
