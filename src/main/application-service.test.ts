import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Application, ApplicationInstall, ApplicationLaunch } from "@shared/application-contracts";
import type { BrowserScope } from "@shared/browser-contracts";
import { AppRepository } from "./database";
import { ApplicationDockerDriver, ApplicationService } from "./application-service";
import type { BrowserService } from "./browser-service";
import type { EnvironmentService } from "./environment-service";
import { DockerCommandError, type DockerCommandRunner } from "./docker-driver";

const baseImage = `sha256:${"b".repeat(64)}`, installedImage = `sha256:${"c".repeat(64)}`;
type Container = { Image: string; Config: { User: string; Labels: Record<string, string> }; HostConfig: { Privileged: boolean; ReadonlyRootfs: boolean; CapDrop: string[] };
  Mounts: { Type: string; Name: string; Destination: string }[]; State: { Status: string; ExitCode: number } };
type RecordedCommand = { args: string[]; options: Parameters<DockerCommandRunner>[1] };
const cleanup: Array<() => Promise<void>> = [];

function argument(args: string[], option: string): string {
  const index = args.indexOf(option);
  if (index < 0 || args[index + 1] === undefined) throw new Error(`Missing fixture option: ${option}`);
  return args[index + 1]!;
}
function argumentsFor(args: string[], option: string): string[] { return args.flatMap((value, index) => value === option ? [args[index + 1]!] : []); }
function fixture() {
  vi.stubEnv("DOCKER_HOST", undefined);
  const repository = new AppRepository(":memory:"), actor = repository.createBot();
  const scope: BrowserScope = { sessionId: actor.session.id, executorBotId: actor.bot.id };
  const environment = repository.environments.ensure(scope, { workerVersion: "1.2.0", imageRef: "controlled-execution", imageDigest: `sha256:${"e".repeat(64)}`, platform: "linux/amd64" });
  repository.environments.update(scope, environment.version, { state: "running", encryptedToken: "PRIVATE_EXECUTION_WORKER_TOKEN" });
  const browserRecord = repository.browsers.ensure(scope, { environmentId: environment.id });
  repository.browsers.updateConnection(scope, { workerVersion: "1.2.0", imageDigest: baseImage, platform: "linux/amd64", encryptedToken: "PRIVATE_BROWSER_WORKER_TOKEN" });
  repository.browsers.update(scope, repository.browsers.get(scope)!.version, { state: "running" });
  const browser = { view: vi.fn(async () => repository.browsers.view(scope)) };
  const environments = { get: vi.fn(async () => repository.environments.get(scope)) };
  const commands: RecordedCommand[] = [], containers = new Map<string, Container>();
  const contexts: { files: string[]; dockerfile: string }[] = [];
  const control = { failBuild: false, failTag: false, architecture: "amd64", imageId: installedImage, unknownLaunch: false, createBeforeUnknown: true, applicationId: "" };
  const workerLabels = { "io.aevoren.role": "browser-worker", "io.aevoren.worker-version": "1.2.0", "io.aevoren.worker-bundle": "d".repeat(64) };
  const images = new Map<string, object>([[baseImage, { Id: baseImage, Os: "linux", Architecture: "amd64", Config: { Labels: workerLabels } }]]);
  const response = (value: unknown) => ({ stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
  const runner: DockerCommandRunner = vi.fn(async (raw, options) => {
    options?.signal?.throwIfAborted();
    const args = raw[0] === "--context" ? raw.slice(2) : raw;
    commands.push({ args, options });
    if (args.join(" ") === "context show") return response("controlled-local");
    if (args[0] === "context" && args[1] === "inspect") return response(JSON.stringify("npipe:////./pipe/docker_engine"));
    if (args[0] === "image" && args[1] === "inspect") {
      const image = images.get(args[2]!); if (!image) throw new DockerCommandError("DOCKER_COMMAND_FAILED", "No such image");
      return response(image);
    }
    if (args[0] === "tag") {
      if (control.failTag) throw new DockerCommandError("DOCKER_COMMAND_FAILED", "controlled local tag failed");
      const original = images.get(args[1]!); if (!original) throw new DockerCommandError("DOCKER_COMMAND_FAILED", "No such image");
      images.set(args[2]!, original); return response("");
    }
    if (args[0] === "build") {
      const directory = args.at(-1)!;
      contexts.push({ files: await readdir(directory), dockerfile: await readFile(join(directory, "Dockerfile"), "utf8") });
      control.applicationId = argument(args, "--tag").split(":")[1]!;
      const from = contexts.at(-1)!.dockerfile.split("\n")[0]!;
      expect(from).toBe(`FROM aevoren-application-base:${control.applicationId}`);
      expect(images.has(from.slice("FROM ".length))).toBe(true);
      if (control.failBuild) throw new DockerCommandError("DOCKER_COMMAND_FAILED", "controlled package installation failed");
      const image = { Id: control.imageId, Os: "linux", Architecture: control.architecture, Config: { Labels: { ...workerLabels, "io.aevoren.application-install": control.applicationId } } };
      images.set(control.imageId, image); images.set(argument(args, "--tag"), image);
      return response("controlled image built");
    }
    if (args[0] === "run" && args.includes("--rm")) return response("xterm=1.0\n");
    if (args[0] === "run") {
      const name = argument(args, "--name"), labels = Object.fromEntries(argumentsFor(args, "--label").map(value => { const index = value.indexOf("="); return [value.slice(0, index), value.slice(index + 1)]; }));
      if (!control.unknownLaunch || control.createBeforeUnknown) containers.set(name, {
        Image: args[args.indexOf("--entrypoint") + 2]!, Config: { User: argument(args, "--user"), Labels: labels },
        HostConfig: { Privileged: args.includes("--privileged"), ReadonlyRootfs: args.includes("--read-only"), CapDrop: argumentsFor(args, "--cap-drop") },
        Mounts: argumentsFor(args, "--mount").map(value => { const parts = Object.fromEntries(value.split(",").map(item => item.split("="))); return { Type: parts.type!, Name: parts.source!, Destination: parts.target! }; }),
        State: { Status: "running", ExitCode: 0 },
      });
      if (control.unknownLaunch) throw new DockerCommandError("DOCKER_TIMEOUT", "controlled lost launch acknowledgement");
      return response("controlled-container");
    }
    if (args[0] === "container" && args[1] === "inspect") {
      if (args[2] === `aevoren-browser-${browserRecord.id}`) return response({ Id: "controlled-browser", Image: baseImage,
        Config: { Labels: { "io.aevoren.role": "browser-environment", "io.aevoren.browser": browserRecord.id, "io.aevoren.environment": environment.id, "io.aevoren.computer-layout": "2" } },
        HostConfig: { ReadonlyRootfs: true, CapDrop: ["ALL"] },
        Mounts: [
          { Type: "volume", Name: `aevoren-computer-state-${environment.id}-v2`, Destination: "/var/lib/aevoren-browser-state" },
          { Type: "volume", Name: `aevoren-work-${environment.id}`, Destination: "/workspace" },
          ...[["home", "/home/aevoren"], ["profile", "/home/aevoren/.config/chromium"], ["downloads", "/workspace/Downloads"], ["display", "/tmp/.X11-unix"]].map(([kind, target]) => ({ Type: "volume", Name: `aevoren-computer-${kind}-${environment.id}-v2`, Destination: target })),
        ], State: { Status: "running" }, NetworkSettings: { Ports: { "8081/tcp": [{ HostIp: "127.0.0.1", HostPort: "45001" }] } } });
      const actual = containers.get(args[2]!);
      if (!actual) throw new DockerCommandError("DOCKER_COMMAND_FAILED", "No such container");
      return response(args.at(-1) === "{{json .State}}" ? actual.State : actual);
    }
    if (args[0] === "pause" || args[0] === "unpause") {
      const actual = containers.get(args[1]!); if (!actual) throw new Error("Missing controlled container");
      actual.State.Status = args[0] === "pause" ? "paused" : "running"; return response("");
    }
    if (args[0] === "stop") {
      const actual = containers.get(args.at(-1)!); if (!actual) throw new Error("Missing controlled container");
      actual.State.Status = "exited"; return response("");
    }
    throw new Error(`Unexpected controlled Docker command: ${args.join(" ")}`);
  });
  const docker = new ApplicationDockerDriver(runner);
  let service = new ApplicationService(repository, browser as unknown as BrowserService, environments as unknown as EnvironmentService, docker);
  const value = { repository, scope, environment, browser, docker, commands, contexts, containers, control, images,
    get service() { return service; },
    async restart() { await service.close(); service = new ApplicationService(repository, browser as unknown as BrowserService, environments as unknown as EnvironmentService, docker); },
    owner(owner: "ai" | "user") { const current = repository.browsers.view(scope)!; repository.browsers.claimControl(scope, { expectedEpoch: current.epoch, owner }); },
  };
  cleanup.push(async () => { await service.close(); repository.close(); }); return value;
}
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function installInput(scope: BrowserScope): ApplicationInstall { return { ...scope, clientNonce: randomUUID(), name: "Controlled app", source: { kind: "apt", packages: ["xterm"], executable: "/usr/bin/xterm" } }; }
function launchInput(scope: BrowserScope, id = "terminal"): ApplicationLaunch { return { ...scope, clientNonce: randomUUID(), id, args: [] }; }
function launchCommands(f: ReturnType<typeof fixture>) { return f.commands.filter(command => command.args[0] === "run" && command.args.includes("--detach")); }
async function result(f: ReturnType<typeof fixture>, input: ApplicationInstall) {
  const started = await f.service.install(input, true);
  await expect.poll(() => f.repository.applications.list(f.scope).find(value => value.id === started.id)?.state).not.toBe("building");
  return f.repository.applications.list(f.scope).find(value => value.id === started.id)!;
}

describe("application lifecycle (real SQLite, controlled Docker and download adapters)", () => {
  it("keeps the existing computer image usable when package installation fails", async () => {
    const f = fixture(), before = f.repository.browsers.getInternal(f.scope)!.imageDigest;
    f.control.failBuild = true;
    const application = await result(f, installInput(f.scope));
    expect(application.state).toBe("failed"); expect(application.imageDigest).toBeNull();
    expect(f.contexts).toHaveLength(1); expect(application.error).toContain("原电脑保持可用");
    expect(f.repository.browsers.getInternal(f.scope)!.imageDigest).toBe(before);
    expect((await f.service.launch(launchInput(f.scope), true)).state).toBe("running");
    expect(launchCommands(f)[0]!.args).toContain(baseImage);
  });

  it("keeps the original computer usable when the verified base image cannot be tagged", async () => {
    const f = fixture(), original = f.images.get(baseImage); f.control.failTag = true;
    const application = await result(f, installInput(f.scope));
    expect(application.state).toBe("failed"); expect(application.imageDigest).toBeNull();
    expect(f.contexts).toHaveLength(0); expect(f.images.get(baseImage)).toBe(original);
    expect(f.repository.browsers.getInternal(f.scope)!.imageDigest).toBe(baseImage);
    expect((await f.service.launch(launchInput(f.scope), true)).state).toBe("running");
  });

  it.each(["wrong architecture", "invalid image digest"])("does not promote a built image with %s", async failure => {
    const f = fixture();
    if (failure === "wrong architecture") f.control.architecture = "arm64";
    else f.control.imageId = "unverified:latest";
    const application = await result(f, installInput(f.scope));
    expect(application.state).toBe("failed"); expect(application.imageDigest).toBeNull();
    expect(f.contexts).toHaveLength(1); expect(application.error).toContain("ENVIRONMENT_IMAGE_INVALID");
    expect(f.repository.browsers.getInternal(f.scope)!.imageDigest).toBe(baseImage);
    await expect(f.service.launch(launchInput(f.scope, application.id), true)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(launchCommands(f)).toHaveLength(0);
  });

  it.each(["wrong source digest", "wrong binary architecture"])("rejects %s before building or promoting", async failure => {
    const f = fixture(), bytes = Buffer.alloc(20); Buffer.from([127, 69, 76, 70]).copy(bytes); bytes.writeUInt16LE(failure === "wrong binary architecture" ? 183 : 62, 18);
    vi.spyOn(f.service as unknown as { bytes(url: string, signal: AbortSignal): Promise<Buffer> }, "bytes").mockResolvedValue(bytes);
    const source = { kind: "portable" as const, executable: "/opt/aevoren-application/program" as const, url: "https://controlled.invalid/app", sha256: failure === "wrong source digest" ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex") };
    const application = await result(f, { ...installInput(f.scope), source });
    expect(application.state).toBe("failed"); expect(application.error).toContain("ENVIRONMENT_IMAGE_INVALID");
    expect(f.contexts).toHaveLength(0); expect(application.imageDigest).toBeNull();
    expect(f.repository.browsers.getInternal(f.scope)!.imageDigest).toBe(baseImage);
  });

  it("reuses installation and application launch nonces without duplicate builds or processes", async () => {
    const f = fixture(), input = installInput(f.scope), application = await result(f, input);
    expect((await f.service.install(input, true)).id).toBe(application.id); expect(f.contexts).toHaveLength(1);
    const launch = launchInput(f.scope, application.id), first = await f.service.launch(launch, true);
    expect(await f.service.launch(launch, true)).toEqual(first); expect(launchCommands(f)).toHaveLength(1);
    await expect(f.service.launch({ ...launch, args: ["different-input"] }, true)).rejects.toMatchObject({ code: "COMPUTER_TASK_CONFLICT" });
    expect(launchCommands(f)).toHaveLength(1);
  });

  it("layers successive installations and launches the terminal from the latest installed computer image", async () => {
    const f = fixture(), first = await result(f, installInput(f.scope)), nextImage = `sha256:${"f".repeat(64)}`;
    expect(first.state).toBe("installed"); f.control.imageId = nextImage;
    const second = await result(f, { ...installInput(f.scope), name: "Controlled clock", source: { kind: "apt", packages: ["x11-apps"], executable: "/usr/bin/xclock" } });
    expect(second.state).toBe("installed"); expect(second.baseImageDigest).toBe(first.imageDigest);
    const baseRef = `aevoren-application-base:${second.id}`;
    expect(f.contexts[1]!.dockerfile).toContain(`FROM ${baseRef}\n`);
    expect(f.commands.some(command => JSON.stringify(command.args) === JSON.stringify(["tag", first.imageDigest, baseRef]))).toBe(true);
    expect(f.images.get(baseRef)).toBe(f.images.get(first.imageDigest!));
    expect(f.service.list(f.scope).find(application => application.id === "terminal")!.imageDigest).toBe(nextImage);
    await f.service.launch(launchInput(f.scope), true);
    expect(launchCommands(f)[0]!.args).toContain(nextImage);
    expect(launchCommands(f)[0]!.args).not.toContain(baseImage);
  });

  it.each(["running", "unknown"])("keeps a new installation pending while an application is %s and applies it only after stopping", async state => {
    const f = fixture(), input = launchInput(f.scope);
    if (state === "unknown") {
      f.control.unknownLaunch = true;
      await expect(f.service.launch(input, true)).rejects.toMatchObject({ code: "DOCKER_TIMEOUT" });
      f.control.unknownLaunch = false;
    } else await f.service.launch(input, true);
    const application = await result(f, installInput(f.scope));
    expect(application.state).toBe("pending");
    expect(f.service.list(f.scope).find(value => value.id === application.id)!.state).toBe("pending");
    expect(f.service.list(f.scope).find(value => value.id === "terminal")!.imageDigest).toBe(baseImage);
    await expect(f.service.launch(launchInput(f.scope, application.id), true)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await f.service.stopScope(f.scope, false);
    expect(f.service.list(f.scope).find(value => value.id === application.id)!.state).toBe("installed");
    expect(f.service.list(f.scope).find(value => value.id === "terminal")!.imageDigest).toBe(installedImage);
    // The old nonce refers to the original image, even after a new one is active.
    expect((await f.service.launch(input, true)).state).toBe("exited");
    expect(launchCommands(f)).toHaveLength(1);
    await f.service.launch(launchInput(f.scope), true);
    expect(launchCommands(f)[1]!.args).toContain(installedImage);
  });

  it("queues builds for one computer and layers the second only after the first completes", async () => {
    const f = fixture(), builder = f.service as unknown as { build(scope: BrowserScope, application: Application): Promise<void> };
    const build = builder.build.bind(builder), order: string[] = [], nextImage = `sha256:${"f".repeat(64)}`;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(builder, "build").mockImplementation(async (scope, application) => {
      const first = order.length === 0; order.push(`start:${application.id}`);
      if (first) await held;
      f.control.imageId = first ? installedImage : nextImage;
      await build(scope, application); order.push(`end:${application.id}`);
    });
    const first = await f.service.install(installInput(f.scope), true);
    await expect.poll(() => order).toEqual([`start:${first.id}`]);
    const second = await f.service.install({ ...installInput(f.scope), name: "Second controlled app" }, true);
    try {
      expect(order).toEqual([`start:${first.id}`]);
      expect(f.repository.applications.list(f.scope).find(value => value.id === second.id)!.state).toBe("building");
    } finally { release(); }
    await expect.poll(() => f.repository.applications.list(f.scope).map(value => value.state)).toEqual(["installed", "installed"]);
    expect(order).toEqual([`start:${first.id}`, `end:${first.id}`, `start:${second.id}`, `end:${second.id}`]);
    const baseRef = `aevoren-application-base:${second.id}`;
    expect(f.contexts[1]!.dockerfile).toContain(`FROM ${baseRef}\n`);
    expect(f.commands.some(command => JSON.stringify(command.args) === JSON.stringify(["tag", installedImage, baseRef]))).toBe(true);
    expect(f.images.get(baseRef)).toBe(f.images.get(installedImage));
  });

  it("cancels a queued installation before any Docker build is dispatched for it", async () => {
    const f = fixture(), builder = f.service as unknown as { build(scope: BrowserScope, application: Application): Promise<void> };
    const build = builder.build.bind(builder), started: string[] = [];
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(builder, "build").mockImplementation(async (scope, application) => { started.push(application.id); await held; await build(scope, application); });
    const first = await f.service.install(installInput(f.scope), true);
    await expect.poll(() => started).toEqual([first.id]);
    const second = await f.service.install({ ...installInput(f.scope), name: "Cancelled queued app" }, true);
    try {
      f.service.cancelBuild(f.scope, second.id);
      expect(f.repository.applications.list(f.scope).find(value => value.id === second.id)).toMatchObject({ state: "interrupted", error: "TOOL_EXECUTION_CANCELLED" });
    } finally { release(); }
    await expect.poll(() => f.repository.applications.list(f.scope).find(value => value.id === first.id)!.state).toBe("installed");
    await f.service.close();
    expect(started).toEqual([first.id]); expect(f.contexts).toHaveLength(1);
  });

  it("freezes AI application containers during takeover, blocks new AI launches and unfreezes only those containers on return", async () => {
    const f = fixture(), ai = await f.service.launch(launchInput(f.scope), true), user = await f.service.launch(launchInput(f.scope), false);
    f.owner("user"); await f.service.pauseAutomation(f.scope, true);
    expect(f.containers.get(`aevoren-application-${ai.id}`)!.State.Status).toBe("paused");
    expect(f.containers.get(`aevoren-application-${user.id}`)!.State.Status).toBe("running");
    await expect(f.service.launch(launchInput(f.scope), true)).rejects.toMatchObject({ code: "COMPUTER_USER_CONTROLLED" });
    expect(launchCommands(f)).toHaveLength(2);
    f.owner("ai"); await f.service.pauseAutomation(f.scope, false);
    expect(f.containers.get(`aevoren-application-${ai.id}`)!.State.Status).toBe("running");
    expect(f.commands.filter(command => command.args[0] === "pause" || command.args[0] === "unpause").map(command => command.args)).toEqual([
      ["pause", `aevoren-application-${ai.id}`], ["unpause", `aevoren-application-${ai.id}`],
    ]);
    expect((await f.service.launch(launchInput(f.scope), true)).state).toBe("running");
  });

  it.each([true, false])("reconciles an unknown launch without replay, including across restart (container exists: %j)", async exists => {
    const f = fixture(), input = launchInput(f.scope);
    f.control.unknownLaunch = true; f.control.createBeforeUnknown = exists;
    await expect(f.service.launch(input, true)).rejects.toMatchObject({ code: "DOCKER_TIMEOUT" });
    expect(f.repository.applications.launches(f.environment.id)[0]!.state).toBe("unknown");
    await f.restart(); f.control.unknownLaunch = false;
    if (exists) expect((await f.service.launch(input, true)).state).toBe("running");
    else await expect(f.service.launch(input, true)).rejects.toMatchObject({ code: "TOOL_STATE_INVALID" });
    expect(launchCommands(f)).toHaveLength(1);
  });

  it("refuses an existing application container with an unexpected credential volume", async () => {
    const f = fixture(), input = launchInput(f.scope), application = await f.service.launch(input, true);
    const container = f.containers.get(`aevoren-application-${application.id}`)!;
    container.Mounts.push({ Type: "volume", Name: "private-worker-state", Destination: "/var/lib/aevoren-browser-state" });
    await expect(f.service.launch(input, true)).rejects.toMatchObject({ code: "TOOL_STATE_INVALID" });
    await expect(f.service.pauseAutomation(f.scope, true)).rejects.toMatchObject({ code: "BROWSER_SCOPE_INVALID" });
    expect(launchCommands(f)).toHaveLength(1);
    expect(f.commands.some(command => command.args[0] === "pause")).toBe(false);
  });

  it("builds without user data and launches with only scoped computer volumes and explicit desktop environment variables", async () => {
    const f = fixture(); vi.stubEnv("OPENAI_API_KEY", "PRIVATE_HOST_MODEL_KEY"); vi.stubEnv("AEVOREN_BROWSER_TOKEN", "PRIVATE_HOST_BROWSER_TOKEN");
    const application = await result(f, installInput(f.scope));
    expect(application.state).toBe("installed");
    const baseRef = `aevoren-application-base:${application.id}`;
    expect(f.contexts).toEqual([{ files: ["Dockerfile"], dockerfile: expect.stringContaining(`FROM ${baseRef}\n`) }]);
    expect(f.commands.some(command => JSON.stringify(command.args) === JSON.stringify(["tag", baseImage, baseRef]))).toBe(true);
    expect(f.images.get(baseRef)).toBe(f.images.get(baseImage));
    await f.service.launch(launchInput(f.scope, application.id), true);
    const run = launchCommands(f)[0]!;
    expect(argumentsFor(run.args, "--env")).toEqual(["DISPLAY=:99", "HOME=/home/aevoren", "LANG=C.UTF-8"]);
    expect(argumentsFor(run.args, "--mount").toSorted()).toEqual([
      `type=volume,source=aevoren-work-${f.environment.id},target=/workspace`,
      `type=volume,source=aevoren-computer-home-${f.environment.id}-v2,target=/home/aevoren`,
      `type=volume,source=aevoren-computer-profile-${f.environment.id}-v2,target=/home/aevoren/.config/chromium`,
      `type=volume,source=aevoren-computer-downloads-${f.environment.id}-v2,target=/workspace/Downloads`,
      `type=volume,source=aevoren-computer-display-${f.environment.id}-v2,target=/tmp/.X11-unix`,
    ].toSorted());
    expect(argument(run.args, "--user")).toBe("1000:1000"); expect(run.args).toContain("--read-only");
    expect(argumentsFor(run.args, "--cap-drop")).toEqual(["ALL"]); expect(run.args).not.toContain("--privileged");
    expect(run.options?.env).toBeUndefined();
    const material = JSON.stringify({ commands: f.commands, contexts: f.contexts });
    for (const secret of ["PRIVATE_HOST_MODEL_KEY", "PRIVATE_HOST_BROWSER_TOKEN", "PRIVATE_BROWSER_WORKER_TOKEN", "PRIVATE_EXECUTION_WORKER_TOKEN"]) expect(material).not.toContain(secret);
    expect(material).not.toContain("docker.sock"); expect(material).not.toContain("/var/lib/aevoren-browser-state");
  });
});
