import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { AppRepository } from "./database";
import { BrowserService } from "./browser-service";
import { BrowserDockerDriver } from "./browser-docker-driver";
import { EnvironmentService } from "./environment-service";
import { ExecutionWorkerClient } from "./execution-worker-client";
import { computerVolumes } from "./computer-layout";

const command = promisify(execFile);
it.skipIf(process.env.AEVOREN_BROWSER_DOCKER_TEST !== "1")("migrates actual legacy-layout volumes only when idle and rolls back a failed switch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aevoren-computer-migration-")), repository = new AppRepository(join(directory, "app.sqlite"));
  const owner = repository.createBot(), scope = { sessionId: owner.session.id, executorBotId: owner.bot.id };
  const codec = { isAvailable: () => true, encrypt: (value: string) => Buffer.from(value).toString("base64"), decrypt: (value: string) => Buffer.from(value, "base64").toString() };
  const docker = new BrowserDockerDriver(), environments = new EnvironmentService(repository.environments, codec, join(process.cwd(), "out/worker"));
  const browser = new BrowserService(repository, codec, join(process.cwd(), "out/browser-worker"), join(directory, "media"), environments, undefined, docker);
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html"); response.setHeader("set-cookie", "migration_cookie=preserved; Max-Age=3600; Path=/; HttpOnly");
    response.end(`<title>Migration fixture</title><p>${request.headers.cookie ?? "no cookie"}</p>`);
  });
  await new Promise<void>(resolve => server.listen(0, "0.0.0.0", resolve));
  const port = (server.address() as { port: number }).port;
  const host = process.platform === "linux" ? (await command("docker", ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"])).stdout.trim() : "host.docker.internal";
  let environmentId: string | undefined, browserId: string | undefined, phase = "prepare", primaryError: unknown;
  try {
    await environments.initialize(); await environments.start(scope);
    const original = repository.environments.getInternal(scope)!; environmentId = original.id;
    // Reproduce the old layout with the real current execution binary. This
    // tests layout/data migration, independently of downloading a historic image.
    await docker.stop(original.id); await docker.remove(original.id);
    await command("docker", ["run", "--detach", "--init", "--name", `aevoren-execution-${original.id}`,
      "--label", "io.aevoren.role=execution-environment", "--label", `io.aevoren.environment=${original.id}`,
      "--read-only", "--memory", "768m", "--pids-limit", "256", "--cap-drop", "ALL", ...["SETUID", "SETGID", "KILL", "CHOWN"].flatMap(value => ["--cap-add", value]), "--security-opt", "no-new-privileges",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=128m", "--publish", "127.0.0.1::8080", "--mount", `type=volume,source=aevoren-work-${original.id},target=/workspace`, "--mount", `type=volume,source=aevoren-state-${original.id},target=/var/lib/aevoren`,
      "--env", `AEVOREN_WORKER_ENVIRONMENT_ID=${original.id}`, "--env", "AEVOREN_WORKER_TOKEN", original.imageDigest], { env: { ...process.env, AEVOREN_WORKER_TOKEN: codec.decrypt(original.encryptedToken!) } });
    await environments.start(scope); expect((await docker.inspect(original.id))?.layoutVersion).toBe(1);
    await environments.writeFile({ ...scope, path: "workspace-marker.txt", content: "WORKSPACE_PRESERVED" });
    const record = repository.browsers.ensure(scope, { environmentId: original.id }); browserId = record.id;
    const image = (await docker.inspectBrowserImage())!, token = randomBytes(32).toString("hex"), network = `aevoren-scope-${original.id}`;
    await command("docker", ["network", "create", "--label", `io.aevoren.environment=${original.id}`, network]);
    await command("docker", ["network", "connect", network, `aevoren-execution-${original.id}`]);
    await command("docker", ["run", "--detach", "--init", "--name", `aevoren-browser-${record.id}`, "--network", network,
      "--label", "io.aevoren.role=browser-environment", "--label", `io.aevoren.environment=${original.id}`, "--label", `io.aevoren.browser=${record.id}`,
      "--read-only", "--memory", "768m", "--pids-limit", "512", "--cap-drop", "ALL", ...["SETUID", "SETGID", "KILL", "CHOWN"].flatMap(value => ["--cap-add", value]), "--security-opt", "no-new-privileges",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--publish", "127.0.0.1::8081", ...(process.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : []),
      ...["state", "profile", "downloads"].flatMap(kind => ["--mount", `type=volume,source=aevoren-browser-${kind}-${record.id},target=/var/lib/aevoren-browser-${kind}`]),
      "--env", "AEVOREN_BROWSER_TOKEN", "--env", `AEVOREN_BROWSER_ENVIRONMENT_ID=${original.id}`, "--env", `AEVOREN_BROWSER_SESSION_ID=${record.id}`, image.id], { env: { ...process.env, AEVOREN_BROWSER_TOKEN: token } });
    const legacy = (await docker.inspectBrowser(record.id, original.id))!, client = new ExecutionWorkerClient(legacy.workerPort!, token, original.id);
    const health = await client.waitHealthy(undefined, 50_000) as import("@shared/browser-contracts").BrowserWorkerHealth;
    repository.browsers.updateConnection(scope, { encryptedToken: codec.encrypt(token), containerId: legacy.id, workerPort: legacy.workerPort, imageRef: image.ref, imageDigest: image.id, workerVersion: image.workerVersion, platform: image.platform });
    repository.browsers.syncControl(scope, health.control, health.bootId); repository.browsers.update(scope, repository.browsers.get(scope)!.version, { state: "running" });
    await client.request("/v1/browser/pages", "POST", { actor: "user", expectedEpoch: health.control.controlEpoch, operationId: randomUUID(), url: `http://${host}:${port}/` });
    await command("docker", ["exec", "--user", "1000:1000", legacy.name, "/bin/sh", "-ec", "printf PROFILE_PRESERVED > /var/lib/aevoren-browser-profile/migration-marker; printf DOWNLOAD_PRESERVED > /var/lib/aevoren-browser-downloads/migration-marker"]);
    phase = "legacy execution binding";
    await environments.reconcileBinding(scope);
    const job = await environments.run({ ...scope, clientNonce: randomUUID(), command: "sleep 120" });
    phase = "busy migration refusal";
    await expect(browser.start({ ...scope, clientNonce: randomUUID() })).rejects.toMatchObject({ code: "ENVIRONMENT_EXECUTION_CONFLICT" });
    expect((await docker.inspectBrowser(record.id, original.id))?.layoutVersion).toBe(1);
    await environments.cancel({ ...scope, id: job.id });
    phase = "rollback after real copy";
    const copy = docker.copyLegacyVolumes.bind(docker);
    vi.spyOn(docker, "copyLegacyVolumes").mockImplementation(async (...args) => {
      try { await copy(...args); }
      catch (error) { console.error("Controlled volume copy failure", error); throw error; }
    });
    const create = vi.spyOn(docker, "createBrowser").mockRejectedValueOnce(new Error("controlled failure after real copy"));
    await expect(browser.start({ ...scope, clientNonce: randomUUID() })).rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE" });
    expect(create).toHaveBeenCalledOnce();
    expect((await docker.inspectBrowser(record.id, original.id))?.layoutVersion).toBe(1);
    expect((await docker.inspect(original.id))?.layoutVersion).toBe(1);
    expect(repository.computerTasks.layoutMigration(original.id)).toBeNull(); create.mockRestore();
    const createReal = docker.createBrowser.bind(docker);
    vi.spyOn(docker, "createBrowser").mockImplementation(async (...args) => {
      const created = await createReal(...args);
      try { await new ExecutionWorkerClient(created.workerPort!, token, original.id).waitHealthy(undefined, 50_000); }
      catch (error) {
        const output = await command("docker", ["logs", created.name]);
        console.error("Controlled migrated desktop startup", output.stdout.slice(-1_000), output.stderr.slice(-3_000).replace(/[a-f0-9]{64}/gu, "[redacted]")); throw error;
      }
      return created;
    });
    phase = "idle migration";
    await browser.start({ ...scope, clientNonce: randomUUID() });
    expect((await docker.inspect(original.id))?.layoutVersion).toBe(2);
    expect((await docker.inspectBrowser(record.id, original.id))?.layoutVersion).toBe(2);
    const markers = (await command("docker", ["exec", "--user", "1000:1000", `aevoren-browser-${record.id}`, "/bin/sh", "-ec", "cat /home/aevoren/.config/chromium/migration-marker; cat /workspace/Downloads/migration-marker; cat /workspace/workspace-marker.txt"])).stdout;
    expect(markers).toBe("PROFILE_PRESERVEDDOWNLOAD_PRESERVEDWORKSPACE_PRESERVED");
    const view = (await browser.view(scope))!;
    await browser.computerScreenshot({ ...scope, expectedEpoch: view.epoch }, { actor: "ai" });
    const page = await browser.newTab({ ...scope, expectedEpoch: view.epoch, clientNonce: randomUUID(), url: `http://${host}:${port}/` }, { actor: "ai" });
    expect((await browser.read({ ...scope, expectedEpoch: view.epoch, pageId: page.id }, { actor: "ai" })).text).toContain("migration_cookie=preserved");
    expect(await docker.inspect(original.id, undefined, true)).not.toBeNull();
    expect(await docker.inspectBrowser(record.id, original.id, undefined, true)).not.toBeNull();
  } catch (error) {
    primaryError = error; console.error("Controlled migration phase", phase, error); throw error;
  } finally { await cleanup(); }
  async function cleanup(): Promise<void> {
    try {
    vi.restoreAllMocks(); await browser.shutdown(); await environments.shutdown();
    if (environmentId) {
      if (browserId) {
        await docker.stopBrowser(browserId, environmentId, true);
        const backup = await docker.inspectBrowser(browserId, environmentId, undefined, true);
        if (backup) await command("docker", ["rm", "--force", backup.name]);
      }
      await docker.stop(environmentId); await docker.remove(environmentId);
      const backup = await docker.inspect(environmentId, undefined, true); if (backup) await command("docker", ["rm", "--force", backup.name]);
      await command("docker", ["network", "rm", `aevoren-scope-${environmentId}`]);
      const existing = new Set((await command("docker", ["volume", "ls", "--format", "{{.Name}}"])).stdout.trim().split("\n"));
      const volumes = [`aevoren-work-${environmentId}`, `aevoren-state-${environmentId}`, `aevoren-computer-state-${environmentId}-v2`, ...Object.values(computerVolumes(environmentId)).map(value => value.source), ...["state", "profile", "downloads"].map(kind => `aevoren-browser-${kind}-${browserId}`)].filter(name => existing.has(name));
      if (volumes.length) await command("docker", ["volume", "rm", ...volumes]);
    }
    } catch (error) { if (!primaryError) throw error; console.error("Controlled migration cleanup failed", error); }
    finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); repository.close(); if (!primaryError) await rm(directory, { recursive: true, force: true }); }
  }
}, 240_000);
