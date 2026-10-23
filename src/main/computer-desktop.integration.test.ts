import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppRepository } from "./database";
import { BrowserService } from "./browser-service";
import { EnvironmentService } from "./environment-service";
import { ApplicationService } from "./application-service";
import { BrowserDockerDriver } from "./browser-docker-driver";
import { computerVolumes } from "./computer-layout";
import type { DesktopWindow } from "@shared/browser-contracts";
import { createComputerToolGateway } from "./computer-tool-gateway";

const command = promisify(execFile);
// A readiness check may itself perform a Worker request with its existing 15s
// bound. Vitest's 1s polling default can expire before that single request settles.
const readiness = { timeout: 15_000, interval: 200 };
describe.skipIf(process.env.AEVOREN_BROWSER_DOCKER_TEST !== "1")("unified computer with actual Docker, desktop windows and files", () => {
  let root: string, repository: AppRepository, environment: EnvironmentService, browser: BrowserService, applications: ApplicationService, host = "host.docker.internal";
  const docker = new BrowserDockerDriver();
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "aevoren-unified-computer-")); repository = new AppRepository(join(root, "app.sqlite"));
    const codec = { isAvailable: () => true, encrypt: (value: string) => Buffer.from(value).toString("base64"), decrypt: (value: string) => Buffer.from(value, "base64").toString() };
    environment = new EnvironmentService(repository.environments, codec, join(process.cwd(), "out/worker"));
    await environment.initialize();
    browser = new BrowserService(repository, codec, join(process.cwd(), "out/browser-worker"), join(root, "media"), environment);
    applications = new ApplicationService(repository, browser, environment);
    browser.setControlLifecycle((scope, owner) => applications.pauseAutomation(scope, owner === "user"));
    if (process.platform === "linux") host = (await command("docker", ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"])).stdout.trim();
  }, 900_000);
  // Each case owns its scopes. Stop finished fixtures before allocating the
  // next desktop; retaining every prior case is not a concurrency test.
  afterEach(async () => {
    if (!repository) return;
    for (const { sessionId, executorBotId } of repository.environments.listInternal()) {
      const scope = { sessionId, executorBotId };
      await applications.stopScope(scope, true);
      const current = repository.browsers.get(scope);
      if (current && current.state !== "stopped") await browser.stop({ ...scope, clientNonce: randomUUID() });
      if (repository.environments.get(scope)?.state !== "stopped") await environment.stop(scope);
    }
  }, 120_000);
  afterAll(async () => {
    if (!repository) return;
    await applications.close(); await browser.shutdown();
    for (const scope of repository.environments.listInternal()) {
      await applications.stopScope(scope, true);
      const record = repository.browsers.get(scope);
      if (record) await docker.stopBrowser(record.id, scope.id, true);
      await docker.stop(scope.id); await docker.remove(scope.id);
      await command("docker", ["network", "rm", `aevoren-scope-${scope.id}`]);
      await command("docker", ["volume", "rm", `aevoren-work-${scope.id}`, `aevoren-state-${scope.id}`, `aevoren-computer-state-${scope.id}-v2`, ...Object.values(computerVolumes(scope.id)).map(value => value.source)]);
    }
    await environment.shutdown(); repository.close(); await rm(root, { recursive: true, force: true });
  }, 120_000);
  it("returns a stopped human-owned desktop through real Docker without resetting files or control proofs", async () => {
    const created = repository.createBot(), scope = { sessionId: created.session.id, executorBotId: created.bot.id };
    await browser.start({ ...scope, clientNonce: randomUUID() });
    await environment.writeFile({ ...scope, path: "recovery-marker.txt", content: "PRESERVED_STOPPED_DESKTOP" });
    let view = (await browser.view(scope))!;
    view = await browser.takeover({ ...scope, expectedEpoch: view.epoch, clientNonce: randomUUID() });
    const previousEpoch = view.epoch;
    await browser.stop({ ...scope, clientNonce: randomUUID() });
    expect(repository.browsers.get(scope)?.state).toBe("stopped");
    expect(repository.browsers.view(scope)?.owner).toBe("user");
    await expect(browser.returnControl({ ...scope, expectedEpoch: previousEpoch, clientNonce: randomUUID() }, { actor: "ai" })).rejects.toMatchObject({ code: "COMPUTER_USER_CONTROLLED" });
    view = await browser.returnControl({ ...scope, expectedEpoch: previousEpoch, clientNonce: randomUUID() });
    expect(view.owner).toBe("ai"); expect(view.epoch).toBeGreaterThan(previousEpoch + 1); expect(view.observedEpoch).toBeNull();
    expect(repository.browsers.get(scope)?.state).toBe("running");
    expect((await environment.readFile({ ...scope, path: "recovery-marker.txt" })).content).toBe("PRESERVED_STOPPED_DESKTOP");
    expect((await browser.computerScreenshot({ ...scope, expectedEpoch: view.epoch }, { actor: "ai" })).frame.size).toBeGreaterThan(1_000);
  }, 180_000);

  it("starts after fresh Worker state on the selected engine without resetting the host epoch or work files", async () => {
    const created = repository.createBot(), scope = { sessionId: created.session.id, executorBotId: created.bot.id };
    await browser.start({ ...scope, clientNonce: randomUUID() });
    await environment.writeFile({ ...scope, path: "engine-marker.txt", content: "PRESERVED_FRESH_WORKER" });
    let view = (await browser.view(scope))!;
    expect(view.epoch).toBe(1);
    view = await browser.takeover({ ...scope, expectedEpoch: view.epoch, clientNonce: randomUUID() });
    view = await browser.returnControl({ ...scope, expectedEpoch: view.epoch, clientNonce: randomUUID() });
    const previous = repository.browsers.get(scope)!, previousEpoch = view.epoch;
    const frame = await browser.computerScreenshot({ ...scope, expectedEpoch: previousEpoch }, { actor: "ai" });
    const attachment = await browser.imageAttachment(scope, frame.media.id, previousEpoch);
    expect(attachment.isAuthorized()).toBe(true);
    await browser.stop({ ...scope, clientNonce: randomUUID() });
    await docker.stopBrowser(previous.id, previous.environmentId, true);
    // Remove only this disposable fixture's Worker lease, retaining its work/profile volumes.
    await command("docker", ["volume", "rm", `aevoren-computer-state-${previous.environmentId}-v2`]);
    await browser.start({ ...scope, clientNonce: randomUUID() });
    view = (await browser.view(scope))!;
    expect(view.owner).toBe("ai"); expect(view.epoch).toBeGreaterThan(previousEpoch);
    expect(repository.browsers.get(scope)?.bootId).not.toBe(previous.bootId);
    expect(attachment.isAuthorized()).toBe(false);
    await expect(browser.computerScreenshot({ ...scope, expectedEpoch: previousEpoch }, { actor: "ai" })).rejects.toMatchObject({ code: "COMPUTER_CONTROL_CHANGED" });
    expect((await browser.computerScreenshot({ ...scope, expectedEpoch: view.epoch }, { actor: "ai" })).frame.size).toBeGreaterThan(1_000);
    expect((await environment.readFile({ ...scope, path: "engine-marker.txt" })).content).toBe("PRESERVED_FRESH_WORKER");
  }, 180_000);

  it("downloads, processes, opens and saves through the same computer while takeover freezes commands", async () => {
    const created = repository.createBot(), scope = { sessionId: created.session.id, executorBotId: created.bot.id };
    const server = createServer((request, response) => {
      if (request.url === "/file") { response.writeHead(200, { "content-disposition": 'attachment; filename="source.txt"', "content-type": "text/plain" }); response.end("DOWNLOAD_ORIGINAL"); }
      else { response.writeHead(200, { "content-type": "text/html" }); response.end('<button onclick="location.href=\'/file\'">Download</button>'); }
    });
    await new Promise<void>(resolve => server.listen(0, "0.0.0.0", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      try { await browser.start({ ...scope, clientNonce: randomUUID() }); }
      catch (error) {
        const failed = repository.browsers.get(scope);
        if (failed) {
          const output = await command("docker", ["logs", `aevoren-browser-${failed.id}`]).catch(failure => ({ stdout: "", stderr: String(failure.stderr ?? failure.message) }));
          console.error("Controlled desktop startup diagnostic", `${output.stdout}\n${output.stderr}`.slice(-5_000).replace(/[a-f0-9]{64}/gu, "[redacted]"));
        }
        throw error;
      }
      const env = repository.environments.get(scope)!;
      expect((await docker.inspect(env.id))?.layoutVersion).toBe(2);
      let view = (await browser.view(scope))!;
      const gateway = createComputerToolGateway(repository, browser, environment, applications);
      const task = repository.computerTasks.create({ ...scope, clientNonce: randomUUID(), goal: "Controlled actual host gateway" }, null, repository.getDefaultModelSelection(), 1).task;
      const pixels = await gateway.execute(task, "computer.screenshot", { expectedEpoch: view.epoch }, randomUUID(), new AbortController().signal);
      expect(pixels.images?.[0]?.isAuthorized()).toBe(true);
      expect(await gateway.execute(task, "computer.windows", { expectedEpoch: view.epoch }, randomUUID(), new AbortController().signal)).toHaveProperty("result");
      const page = await browser.newTab({ ...scope, expectedEpoch: view.epoch, clientNonce: randomUUID(), url: `http://${host}:${port}` }, { actor: "ai" });
      const observed = await browser.observe({ ...scope, expectedEpoch: view.epoch, pageId: page.id }, { actor: "ai" });
      const target = observed.elements.find(element => element.name === "Download")!;
      await browser.click({ ...scope, expectedEpoch: view.epoch, pageId: page.id, documentVersion: observed.documentVersion, observationId: observed.id, ref: target.ref, clientNonce: randomUUID() }, { actor: "ai" });
      await expect.poll(async () => (await browser.downloads({ ...scope, expectedEpoch: view.epoch }, { actor: "ai" })).items.length, readiness).toBe(1);
      const downloaded = (await browser.downloads({ ...scope, expectedEpoch: view.epoch }, { actor: "ai" })).items[0]!;
      // This is a real terminal in a credential-free app container, not a host shell.
      await applications.launch({ ...scope, id: "terminal", clientNonce: randomUUID(), args: ["-e", "/bin/sh", "-lc", `test -d "$HOME/.config/chromium/Default" && tr '[:lower:]' '[:upper:]' < '/workspace/Downloads/${downloaded.id}' > /workspace/processed.txt; printf '\\nTERMINAL_SHARED_PROFILE' >> /workspace/processed.txt`] });
      await expect.poll(async () => { try { return (await environment.readFile({ ...scope, path: "processed.txt" })).content; } catch { return ""; } }, readiness).toContain("DOWNLOAD_ORIGINAL\nTERMINAL_SHARED_PROFILE");
      const fileManager = await applications.launch({ ...scope, id: "files", clientNonce: randomUUID(), args: ["/workspace/Downloads"] });
      await expect.poll(async () => (await browser.computerWindows({ ...scope, expectedEpoch: view.epoch }, { actor: "ai" })).some(window => window.title === "Downloads"), readiness).toBe(true);
      const editorInput = { ...scope, id: "editor", clientNonce: randomUUID(), args: ["/workspace/processed.txt"] };
      const editor = await applications.launch(editorInput);
      expect(fileManager.state).toBe("running"); expect(editor.state).toBe("running");
      expect((await applications.launch(editorInput)).id).toBe(editor.id);
      let editorWindow: DesktopWindow | undefined;
      let previousWindow: string | undefined;
      await expect.poll(async () => {
        const windows = await browser.computerWindows({ ...scope, expectedEpoch: view.epoch }, { actor: "ai" });
        editorWindow = windows.find(window => window.title?.includes("processed.txt"));
        const focused = (await command("docker", ["exec", "--user", "1000:1000", "--env", "DISPLAY=:99", `aevoren-browser-${repository.browsers.get(scope)!.id}`, "xdotool", "getwindowfocus"])).stdout.trim();
        const geometry = JSON.stringify({ windows, focused }), settled = Boolean(editorWindow && focused === editorWindow.id && geometry === previousWindow);
        previousWindow = geometry; return settled;
      }, readiness).toBe(true);
      let frame = await browser.computerScreenshot({ ...scope, expectedEpoch: view.epoch }, { actor: "ai" });
      console.error("Controlled focus proof", { currentWindow: frame.frame.desktop, targetWindow: editorWindow });
      await browser.computerFocusWindow({ ...scope, expectedEpoch: view.epoch, observationId: frame.frame.observationId, windowId: editorWindow!.id, clientNonce: randomUUID() }, { actor: "ai" });
      frame = await browser.computerScreenshot({ ...scope, expectedEpoch: view.epoch }, { actor: "ai" });
      expect(frame.frame.desktop).toBeDefined();
      expect((await browser.imageAttachment(scope, frame.media.id, view.epoch)).isAuthorized()).toBe(true);
      await browser.computerKey({ ...scope, expectedEpoch: view.epoch, observationId: frame.frame.observationId, key: "Control+a", clientNonce: randomUUID() }, { actor: "ai" });
      frame = await browser.computerScreenshot({ ...scope, expectedEpoch: view.epoch }, { actor: "ai" });
      await browser.computerType({ ...scope, expectedEpoch: view.epoch, observationId: frame.frame.observationId, text: "GUI_SAVED_ACTUAL", clientNonce: randomUUID() }, { actor: "ai" });
      frame = await browser.computerScreenshot({ ...scope, expectedEpoch: view.epoch }, { actor: "ai" });
      await browser.computerKey({ ...scope, expectedEpoch: view.epoch, observationId: frame.frame.observationId, key: "Control+s", clientNonce: randomUUID() }, { actor: "ai" });
      await expect.poll(async () => (await environment.readFile({ ...scope, path: "processed.txt" })).content, readiness).toBe("GUI_SAVED_ACTUAL");
      expect((await gateway.execute(task, "execution.readFile", { path: "processed.txt" }, randomUUID(), new AbortController().signal)).result).toMatchObject({ content: "GUI_SAVED_ACTUAL" });
      const job = await environment.run({ ...scope, clientNonce: randomUUID(), command: "while true; do printf tick >> heartbeat; sleep .1; done" });
      await expect.poll(async () => { try { return (await environment.readFile({ ...scope, path: "heartbeat" })).size; } catch { return 0; } }, readiness).toBeGreaterThan(4);
      view = await browser.takeover({ ...scope, expectedEpoch: view.epoch, clientNonce: randomUUID() });
      expect((await docker.inspect(env.id))?.state).toBe("running");
      const app = repository.browsers.get(scope)!;
      const readHeartbeat = async () => (await command("docker", ["exec", "--user", "1000:1000", `aevoren-browser-${app.id}`, "cat", "/workspace/heartbeat"])).stdout;
      const before = await readHeartbeat(); await new Promise(resolve => setTimeout(resolve, 300)); expect(await readHeartbeat()).toBe(before);
      await expect(browser.computerScreenshot({ ...scope, expectedEpoch: view.epoch }, { actor: "ai" })).rejects.toMatchObject({ code: "COMPUTER_USER_CONTROLLED" });
      await browser.stop({ ...scope, clientNonce: randomUUID() });
      await browser.start({ ...scope, clientNonce: randomUUID() });
      view = (await browser.view(scope))!;
      expect(view.owner).toBe("user");
      expect((await docker.inspect(env.id))?.state).toBe("running");
      expect(await readHeartbeat()).toBe(before);
      await expect(browser.computerScreenshot({ ...scope, expectedEpoch: view.epoch }, { actor: "ai" })).rejects.toMatchObject({ code: "COMPUTER_USER_CONTROLLED" });
      view = await browser.returnControl({ ...scope, expectedEpoch: view.epoch, clientNonce: randomUUID() });
      expect((await docker.inspect(env.id))?.state).toBe("running");
      await expect.poll(readHeartbeat, readiness).not.toBe(before);
      await environment.cancel({ ...scope, id: job.id });
      // Docker may lose the execution container while retaining its volumes.
      // A single Computer start must recreate it and refresh the desktop's
      // private execution address without replaying the cancelled command.
      const oldExecution = (await docker.inspect(env.id))!.id;
      await applications.stopScope(scope, true);
      await docker.stop(env.id); await docker.remove(env.id);
      await browser.start({ ...scope, clientNonce: randomUUID() });
      expect((await docker.inspect(env.id))!.id).not.toBe(oldExecution);
      expect((await environment.readFile({ ...scope, path: "processed.txt" })).content).toBe("GUI_SAVED_ACTUAL");
      expect((await environment.getExecution({ ...scope, id: job.id })).state).toBe("cancelled");
      view = (await browser.view(scope))!;
      expect((await browser.computerScreenshot({ ...scope, expectedEpoch: view.epoch }, { actor: "ai" })).frame.size).toBeGreaterThan(1_000);
    } catch (error) {
      const environmentRecord = repository.environments.get(scope);
      for (const job of repository.environments.listExecutions(scope)) console.error("Controlled execution diagnostic", {
        job: await environment.getExecution({ ...scope, id: job.id }).catch(error => ({ code: error.code })),
        logs: await environment.logs({ ...scope, id: job.id }).catch(error => ({ code: error.code })),
      });
      if (environmentRecord) for (const app of repository.applications.launches(environmentRecord.id)) {
        const state = await command("docker", ["inspect", "--format", "{{json .State}}", `aevoren-application-${app.id}`], { timeout: 5_000, maxBuffer: 16_384 })
          .then(({ stdout }) => { const value = JSON.parse(stdout); return { Status: value.Status, ExitCode: value.ExitCode, OOMKilled: value.OOMKilled, Error: value.Error }; })
          .catch(error => ({ unavailable: true, code: error.code ?? "DIAGNOSTIC_UNAVAILABLE" }));
        console.error("Controlled GUI state", app.input.id, state);
        const logs = await command("docker", ["logs", `aevoren-application-${app.id}`]).catch(failure => ({ stdout: "", stderr: String(failure.stderr ?? failure.message) }));
        console.error("Controlled GUI diagnostic", app.input.id, `${logs.stdout}\n${logs.stderr}`.slice(-4_000));
      }
      const desktop = repository.browsers.get(scope);
      if (desktop) {
        const native = await command("docker", ["exec", "--user", "1000:1000", "--env", "DISPLAY=:99", `aevoren-browser-${desktop.id}`, "node", "-e",
          "const {spawnSync}=require('node:child_process');const focus=spawnSync('xdotool',['getwindowfocus'],{encoding:'utf8',timeout:1000});const id=String(focus.stdout||'').trim();const geometry=/^\\d+$/.test(id)?spawnSync('xdotool',['getwindowgeometry','--shell',id],{encoding:'utf8',timeout:1000}):null;console.log(JSON.stringify({focusedWindow:/^\\d+$/.test(id)?id:null,focusExitCode:focus.status,geometryExitCode:geometry?.status??null,geometry:String(geometry?.stdout||'').slice(0,1000)}))"], { timeout: 5_000, maxBuffer: 16_384 })
          .then(({ stdout }) => JSON.parse(stdout)).catch(error => ({ unavailable: true, code: error.code ?? "DIAGNOSTIC_UNAVAILABLE" }));
        console.error("Controlled native desktop", native);
      }
      const control = await browser.view(scope).catch(() => null);
      if (control) console.error("Controlled windows", await browser.computerWindows({ ...scope, expectedEpoch: control.epoch }, { actor: "ai" }).catch(() => []));
      throw error;
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 180_000);
  it("builds an actual distro GUI application without user volumes and launches it on the same desktop", async () => {
    const created = repository.createBot(), scope = { sessionId: created.session.id, executorBotId: created.bot.id };
    await browser.start({ ...scope, clientNonce: randomUUID() });
    const original = repository.browsers.getInternal(scope)!, view = repository.browsers.view(scope)!;
    const install = await applications.install({ ...scope, clientNonce: randomUUID(), name: "Controlled X message", source: { kind: "apt", packages: ["x11-utils"], executable: "/usr/bin/xmessage" } });
    await expect.poll(() => applications.list(scope).find(value => value.id === install.id)?.state, { timeout: 180_000, interval: 500 }).not.toBe("building");
    const installed = applications.list(scope).find(value => value.id === install.id)!;
    expect(installed, installed.error ?? "real apt install").toMatchObject({ state: "installed", baseImageDigest: original.imageDigest });
    expect(installed.imageDigest).not.toBe(original.imageDigest);
    expect(installed.packageVersions).toMatch(/x11-utils=\S+/);
    const app = await applications.launch({ ...scope, clientNonce: randomUUID(), id: installed.id, args: ["-title", "Controlled installed GUI", "Installed with actual apt"] });
    expect(app.state).toBe("running");
    await expect.poll(async () => (await browser.computerWindows({ ...scope, expectedEpoch: view.epoch }, { actor: "ai" })).some(window => window.title === "Controlled installed GUI"), readiness).toBe(true);
    const frame = await browser.computerScreenshot({ ...scope, expectedEpoch: view.epoch }, { actor: "ai" });
    expect(frame.frame.size).toBeGreaterThan(1_000);
    const environmentId = repository.environments.get(scope)!.id;
    const container = JSON.parse((await command("docker", ["inspect", `aevoren-application-${app.id}`])).stdout)[0];
    expect(container.Image).toBe(installed.imageDigest);
    expect(container.Mounts.map((mount: { Name: string }) => mount.Name).sort()).toEqual([`aevoren-work-${environmentId}`, ...Object.values(computerVolumes(environmentId)).map(value => value.source)].sort());
    expect(container.Config.Env.some((value: string) => /TOKEN|API_KEY|CREDENTIAL/u.test(value))).toBe(false);
    expect(repository.browsers.getInternal(scope)?.imageDigest).toBe(original.imageDigest);
    await applications.stopScope(scope, true);
  }, 240_000);
});
