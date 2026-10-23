import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { AevorenBotApi, ApiResult, ModelSelection } from "../../src/shared/contracts";
import type { BrowserScope } from "../../src/shared/browser-contracts";
import { BROWSER_WORKER_VERSION } from "../../src/shared/browser-contracts";
import { ENV_WORKER_VERSION } from "../../src/shared/environment-contracts";
import { AppRepository } from "../../src/main/database";
import { computerVolumes } from "../../src/main/computer-layout";
import { DockerDriver } from "../../src/main/docker-driver";
import { BrowserDockerDriver } from "../../src/main/browser-docker-driver";
import { openSettingsFromAccount } from "./navigation";
import { closeTestApplicationWithExit, removeTestDirectory } from "./test-cleanup";

type WireMessage = { role: string; content: unknown };
type WireRequest = { model: string; messages: WireMessage[]; tools?: { function: { name: string } }[] };
type Capture = { model: string; probe: boolean; imageBytes: number; mimeType?: string; answer?: string; width?: number; height?: number };
type Fixture = { page: Page; application: ElectronApplication; scope: BrowserScope; original: ModelSelection; captures: Capture[];
  restart(): Promise<void>; holdProbe(): void; releaseProbe(): void };
function value<T>(result: ApiResult<T>): T { if (!result.ok) throw new Error(`${result.error.code}: ${result.error.safeMessage}`); return result.data; }
async function evidence(name: string, data: unknown): Promise<void> {
  const path = test.info().outputPath(`${name}.json`); writeFileSync(path, JSON.stringify(data, null, 2));
  await test.info().attach(name, { path, contentType: "application/json" });
}
function bundleDigest(directory: string, names: string[]): string {
  const hash = createHash("sha256"); for (const name of names) { hash.update(name); hash.update(readFileSync(join(directory, name))); } return hash.digest("hex");
}
function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  expect([...bytes.subarray(0, 2)]).toEqual([255, 216]); expect([...bytes.subarray(-2)]).toEqual([255, 217]);
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  for (let offset = 2; offset < bytes.length;) {
    if (bytes[offset++] !== 255) throw new Error("Invalid JPEG marker");
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++]; if (marker === undefined || marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw new Error("Invalid JPEG segment length");
    if (frameMarkers.has(marker)) { if (length < 8) throw new Error("Invalid JPEG frame"); return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) }; }
    offset += length;
  }
  throw new Error("No JPEG dimensions");
}

// Decode the actual product-generated PNG, rather than assuming the random
// challenge order or replacing the production model verification result.
function probeAnswer(bytes: Buffer): string {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const idat: Buffer[] = [];
  let width = 0, height = 0;
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
    const content = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = content.readUInt32BE(0); height = content.readUInt32BE(4);
      expect([...content.subarray(8)]).toEqual([8, 2, 0, 0, 0]);
    } else if (type === "IDAT") idat.push(content);
    offset += length + 12;
  }
  expect({ width, height }).toEqual({ width: 300, height: 100 });
  const pixels = inflateSync(Buffer.concat(idat)), stride = width * 3 + 1;
  expect(pixels.length).toBe(stride * height);
  // The controlled product probe deliberately uses unfiltered RGB rows.
  for (let row = 0; row < height; row++) expect(pixels[row * stride]).toBe(0);
  const colors = [50, 150, 250].map(x => {
    const offset = 50 * stride + 1 + x * 3, rgb = [...pixels.subarray(offset, offset + 3)];
    if (rgb[0]! > rgb[1]! && rgb[0]! > rgb[2]!) return "red";
    if (rgb[1]! > rgb[0]! && rgb[1]! > rgb[2]!) return "green";
    if (rgb[2]! > rgb[0]! && rgb[2]! > rgb[1]!) return "blue";
    throw new Error("Probe has no identifiable primary color");
  });
  expect(new Set(colors).size).toBe(3);
  return colors.join(",");
}

function stream(response: ServerResponse, delta: unknown, finish = "stop"): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
}

async function removeOwnedComputers(directory: string): Promise<void> {
  const repository = new AppRepository(join(directory, "aevoren-bot.sqlite"));
  const browsers = repository.browsers.listInternal(), environments = repository.environments.listInternal(); repository.close();
  if (!browsers.length && !environments.length) return;
  const docker = new DockerDriver(), browserDocker = new BrowserDockerDriver(); await docker.probe(); await browserDocker.probe();
  const environment = { ...process.env }; delete environment.DOCKER_HOST; delete environment.DOCKER_CONTEXT;
  const command = (args: string[]): void => {
    try { execFileSync("docker", ["--context", Reflect.get(docker, "context") as string, ...args], { env: environment, stdio: "pipe" }); }
    catch (error) { if (!/no such volume|no such network|network .* not found/iu.test(String((error as { stderr?: Buffer }).stderr ?? ""))) throw error; }
  };
  // IDs come exclusively from this fixture's private database, never a global
  // Docker prune or the user's live Aevoren environment inventory.
  const volumes = new Set<string>();
  for (const browser of browsers) {
    await browserDocker.stopBrowser(browser.id, browser.environmentId, true);
    for (const kind of ["state", "profile", "downloads"]) volumes.add(`aevoren-browser-${kind}-${browser.id}`);
    volumes.add(`aevoren-computer-state-${browser.environmentId}-v2`);
  }
  for (const item of environments) {
    await docker.stop(item.id); await docker.remove(item.id);
    volumes.add(`aevoren-work-${item.id}`); volumes.add(`aevoren-state-${item.id}`);
    for (const volume of Object.values(computerVolumes(item.id))) volumes.add(volume.source);
  }
  // The execution and desktop companions share layout-2 volumes. Remove those
  // only after both containers are gone, rather than failing with "in use".
  for (const volume of volumes) command(["volume", "rm", volume]);
  for (const item of environments) command(["network", "rm", `aevoren-scope-${item.id}`]);
}

// This fixture measures local IPC, settings, real image bytes and the API
// protocol against a simulated model. It is not real-model or package evidence.
async function withComputer(callback: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "aevoren-computer-autonomy-"));
  const repository = new AppRepository(join(directory, "aevoren-bot.sqlite"));
  const created = repository.createBot();
  const original = { providerInstanceId: "openai-compatible.default", modelId: "ordinary-bot-model" };
  repository.updateBot(created.bot.id, created.bot.version, { name: "独立电脑模型验收", modelSelection: original });
  repository.setDefaultModelSelection(original);
  repository.setSetting("memory.capture.enabled", "false", false);
  repository.close();
  const errors: string[] = [], captures: Capture[] = [];
  let hold = false, pending: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/v1/models") { response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "controlled-computer-good" }, { id: "controlled-computer-wrong" }, { id: "controlled-computer-prose" }] })); return; }
      expect(request.url).toBe("/v1/chat/completions");
      let body = ""; for await (const chunk of request) body += chunk;
      const command = JSON.parse(body) as WireRequest;
      const probe = command.messages.some(message => typeof message.content === "string" && message.content.includes("isolated visual and host-tool check"));
      const images = command.messages.flatMap(message => Array.isArray(message.content) ? message.content as { type: string; image_url?: { url: string } }[] : []).filter(part => part.type === "image_url");
      const call = (operation: string, input: unknown): void => stream(response, { tool_calls: [{ index: 0, id: randomUUID(), type: "function", function: { name: "product_execute", arguments: JSON.stringify({ operation, input }) } }] }, "tool_calls");
      if (probe && !images.length) {
        captures.push({ model: command.model, probe, imageBytes: 0 });
        expect(command.tools?.map(tool => tool.function.name)).toContain("product_execute");
        call("computer.screenshot", {}); return;
      }
      if (!probe && !images.length) {
        if (captures.some(capture => !capture.probe)) {
          const output = command.messages.toReversed().find(message => message.role === "tool")?.content;
          throw new Error(`Desktop screenshot was not delivered after its real host call: ${typeof output === "string" ? output.slice(0, 500) : "no tool receipt"}`);
        }
        const receipt = command.messages.find(message => typeof message.content === "string" && message.content.startsWith("Host preparation receipt ("))?.content;
        if (typeof receipt !== "string") throw new Error("No actual host preparation receipt");
        const prepared = JSON.parse(receipt.slice(receipt.indexOf("{"), receipt.lastIndexOf("}") + 1)) as { media: { controlEpoch: number } };
        expect(prepared.media.controlEpoch).toBeGreaterThan(0);
        captures.push({ model: command.model, probe, imageBytes: 0 });
        call("computer.screenshot", { expectedEpoch: prepared.media.controlEpoch }); return;
      }
      expect(images.length, "computer model must receive actual host image pixels").toBeGreaterThan(0);
      const url = images.at(-1)!.image_url!.url;
      expect(url).toMatch(/^data:image\/(?:png|jpeg);base64,/u);
      const mimeType = url.slice(5, url.indexOf(";")); if (probe) expect(mimeType).toBe("image/png");
      const bytes = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
      if (mimeType === "image/png") expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const { width, height } = mimeType === "image/png" ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : jpegDimensions(bytes);
      if (!probe) expect({ width, height }).toEqual({ width: 1280, height: 800 });
      const answer = probe ? probeAnswer(bytes) : undefined;
      captures.push({ model: command.model, probe, imageBytes: bytes.length, mimeType, width, height, ...(answer ? { answer } : {}) });
      if (probe) {
        expect(command.tools?.map(tool => tool.function.name)).toContain("product_execute");
        const send = (): void => call("computer.verify", { answer: command.model.endsWith("wrong") ? "deliberately-wrong" : answer });
        if (hold) { hold = false; pending = send; } else send();
      } else stream(response, { content: "模拟模型声称已全部完成，但没有调用任何操作或提交验证回执。" });
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture port");
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("AEVOREN_BOT_")));
  let application: ElectronApplication | undefined, fixture: Fixture | undefined;
  const pageErrors: string[] = [];
  const mainOutput: string[] = [];
  const launch = async (): Promise<{ application: ElectronApplication; page: Page }> => {
    const executablePath = process.env.AEVOREN_PACKAGED_APP_PATH;
    application = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: [...(executablePath ? [] : ["."]), "--use-mock-keychain"], cwd: process.cwd(),
      env: { ...environment, AEVOREN_BOT_USER_DATA_DIR: directory, AEVOREN_BOT_FAKE_PROVIDER: "0", AEVOREN_BOT_DISABLE_UPDATES: "1", AEVOREN_BOT_TEST_HIDDEN: "1" } });
    const record = (chunk: Buffer): void => { mainOutput.push(chunk.toString().replace(/Bearer\s+[^\s"']+/gu, "Bearer [redacted]").replace(/sk-[A-Za-z0-9_-]+/gu, "[redacted]")); };
    application.process().stderr?.on("data", record); application.process().stdout?.on("data", record);
    const page = await application.firstWindow(); page.on("pageerror", error => pageErrors.push(error.message));
    const renderer = pathToFileURL(join(await application.evaluate(({ app }) => app.getAppPath()), "out", "renderer", "index.html")).href;
    try {
      // Electron exposes the new window before loadFile commits its document.
      // Match the existing library fixture: wait for that navigation, then keep
      // the original 5-second rendered-business assertion unchanged.
      await page.waitForURL(renderer, { waitUntil: "domcontentloaded" });
      await expect(page.locator(".app-shell")).toBeVisible();
    } catch (error) {
      const main = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({ destroyed: window.isDestroyed(), loading: window.webContents.isLoadingMainFrame(), url: window.webContents.getURL() }))).catch(() => []);
      const documentState = await page.evaluate(() => ({ url: location.href, readyState: window.document.readyState, hasApi: Boolean((window as unknown as { aevorenBot?: unknown }).aevorenBot), html: window.document.documentElement.outerHTML.slice(0, 2_000) })).catch(() => null);
      const owned = application.process();
      await evidence("computer-initial-document", { directory, main, document: documentState, pageErrors, exitCode: owned.exitCode, signalCode: owned.signalCode, mainOutput: mainOutput.join("").slice(-10_000) });
      throw error;
    }
    return { application, page };
  };
  try {
    const initial = await launch();
    value(await initial.page.evaluate(async baseUrl => {
      const api = (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot;
      const provider = (await api.providers.list()); if (!provider.ok) return provider;
      const selected = provider.data.find(item => item.id === "openai-compatible.default")!;
      return api.providers.saveOpenAiCompatible({ instanceId: selected.id, expectedVersion: selected.version, baseUrl, apiKey: "isolated-simulated-computer-key" });
    }, `http://127.0.0.1:${address.port}/v1`));
    fixture = { ...initial, scope: { sessionId: created.session.id, executorBotId: created.bot.id }, original, captures,
      holdProbe() { hold = true; }, releaseProbe() { const send = pending; pending = undefined; send?.(); },
      async restart() { await closeTestApplicationWithExit(fixture!.application); application = undefined; Object.assign(fixture!, await launch()); } };
    await callback(fixture);
    expect(pageErrors).toEqual([]); expect(errors).toEqual([]);
    expect(await fixture.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
    await evidence("computer-validation-boundary", { platform: process.platform, hidden: true, source: !process.env.AEVOREN_PACKAGED_APP_PATH, simulatedModel: true, realModel: false, captures });
  } finally {
    pending?.();
    const owned = application?.process(); let normalExit = false;
    try { if (application) { await closeTestApplicationWithExit(application); normalExit = true; } }
    finally {
      await evidence("computer-native-exit", { normalExit, code: owned?.exitCode, signal: owned?.signalCode });
      await evidence("computer-fixture-transport", { errors, captures });
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      // Keep the private ownership database if Docker cleanup fails, so a later
      // diagnostic can identify exactly which fixture resources remain.
      await removeOwnedComputers(directory); removeTestDirectory(directory);
    }
  }
}

test("independent computer model settings protect drafts, preserve Bot selection and persist after restart", async () => {
  test.setTimeout(process.platform === "win32" ? 90_000 : 45_000);
  await withComputer(async f => {
    await openSettingsFromAccount(f.page); await f.page.getByRole("button", { name: "模型", exact: true }).click();
    const panel = f.page.getByRole("region", { name: "电脑执行模型", exact: true });
    await expect(panel).toBeVisible();
    await expect(f.page.getByLabel("电脑模型来源", { exact: true })).toHaveValue(f.original.providerInstanceId);
    await expect(f.page.getByLabel("电脑模型", { exact: true })).toHaveValue(f.original.modelId);
    expect(await f.page.getByLabel("电脑模型来源", { exact: true }).locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value).sort())).toEqual(["claude.default", "codex.default", "openai-compatible.default"]);
    await f.page.getByLabel("电脑模型", { exact: true }).fill("draft-not-saved");
    await f.page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(f.page.getByRole("dialog", { name: "设置", exact: true })).toBeVisible();
    await expect(f.page.getByRole("alert")).toContainText("尚未保存");
    await f.page.getByRole("button", { name: "通用", exact: true }).click();
    await expect(panel).toBeVisible(); await expect(f.page.getByLabel("电脑模型", { exact: true })).toHaveValue("draft-not-saved");
    await f.page.getByRole("button", { name: "放弃修改", exact: true }).click();
    await expect(f.page.getByLabel("电脑模型", { exact: true })).toHaveValue(f.original.modelId);
    await f.page.getByLabel("电脑模型", { exact: true }).fill("controlled-computer-good");
    await f.page.getByRole("button", { name: "保存电脑模型", exact: true }).click();
    await expect(f.page.getByText("电脑模型已保存；正在运行的任务保持原模型。", { exact: true })).toBeVisible();
    const stored = value(await f.page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.computerModel.get()));
    expect(stored.selection).toEqual({ ...f.original, modelId: "controlled-computer-good" });
    expect(value(await f.page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.bots.list())).find(bot => bot.id === f.scope.executorBotId)!.modelSelection).toEqual(f.original);
    await f.restart(); await openSettingsFromAccount(f.page); await f.page.getByRole("button", { name: "模型", exact: true }).click();
    await expect(f.page.getByLabel("电脑模型", { exact: true })).toHaveValue("controlled-computer-good");
    expect(value(await f.page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.computerModel.get()))).toEqual(stored);
    expect(f.captures).toEqual([]);
  });
});

test("computer verification sends real PNG pixels and rejects an incorrect simulated model answer", async () => {
  test.setTimeout(process.platform === "win32" ? 90_000 : 45_000);
  await withComputer(async f => {
    await openSettingsFromAccount(f.page); await f.page.getByRole("button", { name: "模型", exact: true }).click();
    await f.page.getByLabel("电脑模型", { exact: true }).fill("controlled-computer-good"); await f.page.getByRole("button", { name: "保存电脑模型", exact: true }).click();
    await expect(f.page.getByRole("button", { name: "测试图片与工具", exact: true })).toBeEnabled();
    f.holdProbe(); await f.page.getByRole("button", { name: "测试图片与工具", exact: true }).click();
    await expect.poll(() => f.captures.filter(capture => capture.imageBytes > 0).length).toBe(1);
    await f.page.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(f.page.getByRole("dialog", { name: "设置", exact: true })).toBeVisible(); await expect(f.page.getByRole("alert")).toContainText("正在处理");
    f.releaseProbe();
    await expect(f.page.getByText("真实图片识别与宿主工具往返验证通过。此检查不代表所有桌面任务都能完成。", { exact: true })).toBeVisible();
    expect(f.captures.at(-1)).toMatchObject({ model: "controlled-computer-good", probe: true }); expect(f.captures.at(-1)!.imageBytes).toBeGreaterThan(100);
    await f.page.getByLabel("电脑模型", { exact: true }).fill("controlled-computer-wrong"); await f.page.getByRole("button", { name: "保存电脑模型", exact: true }).click();
    const rejected = await f.page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.computerModel.test());
    expect(rejected.ok).toBe(false); if (!rejected.ok) expect(rejected.error.code).toBe("COMPUTER_MODEL_UNSUPPORTED");
    expect(f.captures.filter(capture => capture.imageBytes > 0)).toHaveLength(2); expect(f.captures.filter(capture => capture.imageBytes > 0).every(capture => capture.probe && capture.answer?.split(",").length === 3)).toBe(true);
  });
});

test("a simulated prose-only computer response cannot complete a task on a real isolated desktop", async () => {
  test.skip(process.env.AEVOREN_DOCKER_INTEGRATION !== "1" || process.env.AEVOREN_BROWSER_INTEGRATION !== "1", "Requires the current actual Docker desktop images; no screenshot or task service is simulated.");
  test.setTimeout(240_000);
  await withComputer(async f => {
    // Fail before starting the scope if the coordinator's prebuilt images do
    // not match this candidate. The acceptance test never builds Docker images.
    const paths = await f.application.evaluate(({ app }) => ({ packaged: app.isPackaged, appPath: app.getAppPath(), resources: process.resourcesPath }));
    const executionContext = paths.packaged ? join(paths.resources, "environment-worker") : join(paths.appPath, "out", "worker");
    const browserContext = paths.packaged ? join(paths.resources, "browser-worker") : join(paths.appPath, "out", "browser-worker");
    const docker = new DockerDriver(), browserDocker = new BrowserDockerDriver();
    const probe = await docker.probe(); expect(probe.status).toBe("ready");
    const executionImage = await docker.inspectImage(), browserImage = await browserDocker.inspectBrowserImage();
    expect(executionImage).not.toBeNull(); expect(browserImage).not.toBeNull();
    expect(executionImage!.workerVersion).toBe(ENV_WORKER_VERSION); expect(browserImage!.workerVersion).toBe(BROWSER_WORKER_VERSION);
    expect(executionImage!.bundleSha256).toBe(bundleDigest(executionContext, ["index.mjs", "file-helper.mjs", "Dockerfile"]));
    expect(browserImage!.bundleSha256).toBe(bundleDigest(browserContext, ["index.mjs", "engine.mjs", "Dockerfile", "package.json"]));
    await evidence("computer-docker-inputs", { probe, executionImage, browserImage });
    const configuration = value(await f.page.evaluate(() => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.computerModel.get()));
    value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.computerModel.save(input), { expectedVersion: configuration.version, selection: { ...f.original, modelId: "controlled-computer-prose" } }));
    const task = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.computerTasks.start(input), { ...f.scope, goal: "Inspect this controlled empty desktop without changing files.", clientNonce: randomUUID() }));
    await expect.poll(async () => ["paused", "failed", "cancelled", "completed", "waiting_user", "interrupted"].includes(value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.computerTasks.get(input), { ...f.scope, id: task.id })).task.state), { timeout: 120_000 }).toBe(true);
    const detail = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.computerTasks.get(input), { ...f.scope, id: task.id }));
    const startup = await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.computer.startupStatus(input), f.scope);
    await evidence("computer-prose-task", { detail, startup, captures: f.captures });
    expect(detail.task.state).toBe("paused"); expect(detail.task.errorCode).toBe("MODEL_NO_ACTION");
    expect(detail.steps).toHaveLength(1); expect(detail.steps[0]).toMatchObject({ operation: "computer.screenshot", state: "completed" });
    expect(f.captures.some(capture => !capture.probe && capture.imageBytes > 100)).toBe(true);
    const environment = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.environments.get(input), f.scope));
    const browser = value(await f.page.evaluate(input => (window as unknown as { aevorenBot: AevorenBotApi }).aevorenBot.browser.get(input), f.scope));
    expect(environment?.state).toBe("running"); expect(browser?.state).toBe("running"); expect(environment!.imageDigest).toBe(executionImage!.id);
    const actualExecution = await docker.inspect(environment!.id), actualBrowser = await browserDocker.inspectBrowser(browser!.id, environment!.id);
    expect(actualExecution).toMatchObject({ imageId: executionImage!.id, layoutVersion: 2 }); expect(actualBrowser).toMatchObject({ imageId: browserImage!.id, layoutVersion: 2 });
    await evidence("computer-actual-containers", { scope: f.scope, actualExecution, actualBrowser });
  });
});
