import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserProfileService } from "./user-profile-service";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductToolRequest, ResourceReference } from "@shared/contracts";
import { PRODUCT_OPERATIONS } from "@shared/product-operations";
import { IPC } from "@shared/channels";
import { PRODUCT_OPERATION_SCHEMAS } from "./product-operation-schemas";
import { AppRepository } from "./database";
import { ProductOperationService } from "./product-operation-service";
import type { ProductDependencies } from "./product-handlers";
import { GeneralSettingsService } from "./settings";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { NetworkToolExecutor } from "./network-tool-executor";
import { SendWorker } from "./send-worker";
import { RoomCoordinator } from "./room-coordinator";
import { DemonstrationService } from "./demonstration-service";
import { LibraryService } from "./library-service";
import { MediaService } from "./media-service";
import type { MediaParserAdapter } from "./media-parser-types";
import { writeLibraryExport } from "./library-export";
import type { ModelProvider } from "./model";
import { BrowserService } from "./browser-service";
import type { EnvironmentService } from "./environment-service";
import { AevorenBotError } from "./errors";
vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));

const fixtures: Array<{ repository: AppRepository; root: string; worker: SendWorker }> = [];
function fixture(provider?: ModelProvider) {
  const root = mkdtempSync(join(tmpdir(), "aevoren-product-"));
  const repository = new AppRepository(join(root, "app.sqlite"));
  const actor = repository.createBot();
  const nonce = crypto.randomUUID();
  repository.prepareMessage({ sessionId: actor.session.id, clientNonce: nonce, text: "创建自媒体群并管理设置" });
  const runtime = repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: actor.bot.id, profileVersion: 1, sessionId: actor.session.id, generation: 1, inputSeq: 1, blocks: [], digest: "product-test" });
  repository.transitionRuntimeRun(runtime.id, "dispatching");
  repository.transitionRuntimeRun(runtime.id, "running", { providerRequestId: "test" });
  const executor = new WorkspaceToolExecutor(repository, new WorkspaceService(repository));
  const coordinator = new WorkspaceToolCoordinator(repository, executor, () => {});
  const worker = new SendWorker(repository, null, { transcript: () => {}, sendState: () => {}, runtime: () => {} }, false, provider, undefined, coordinator);
  fixtures.push({ repository, root, worker });
  const workspaceService = new WorkspaceService(repository);
  const libraryService = new LibraryService(repository, join(root, "owned"), { workspaceService });
  const dependencies = { repository, libraryService, workspaceToolCoordinator: coordinator, sendWorker: worker, roomCoordinator: new RoomCoordinator(repository, worker.executor, { transcript: () => {}, roomRuntime: () => {} }), generalSettings: new GeneralSettingsService(repository), providers: { list: async () => [], isSupported: () => true }, updateService: {}, workspaceService, productChanged: vi.fn() } as unknown as ProductDependencies;
  const service = new ProductOperationService(dependencies);
  executor.setProductOperations(service);
  const prepare = (tool: ProductToolRequest, runtimeRunId = runtime.id) => repository.prepareToolInvocation({ runtimeRunId, toolCallId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), tool }, undefined, undefined, service.approvalReview(tool, runtimeRunId));
  const execute = async (tool: ProductToolRequest, runtimeRunId = runtime.id) => {
    const prepared = prepare(tool, runtimeRunId);
    repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
    return executor.execute(prepared.invocation.id);
  };
  return { root, repository, actor, runtime, executor, coordinator, service, prepare, execute, worker, dependencies, libraryService };
}
afterEach(async () => { for (const item of fixtures.splice(0)) { await item.worker.shutdown(); item.repository.close(); rmSync(item.root, { recursive: true, force: true }); } });
const call = (operation: string, input?: unknown): ProductToolRequest => ({ kind: "product-call", action: "execute", operation, ...(input === undefined ? {} : { input }) });

describe("resource measurement receipts", () => {
  it.each([{ transport: "api", action: "describe" }, { transport: "native", action: "describe" }, { transport: "api", action: "execute" }, { transport: "native", action: "execute" }] as const)("corrects a product-wrapped standalone tool using its real schema ($transport/$action)", async ({ transport, action }) => {
    let calls = 0, nativeResponse: string | undefined;
    const replies: string[] = [];
    const provider: ModelProvider = {
      testConnection: async () => {},
      async *run(messages) {
        yield { type: "started", requestId: `wrong-tool-${++calls}` };
        if (calls === 1) {
          yield { type: "project-tool", toolCallId: "wrong-entry", tool: { kind: "product-call", action, operation: "text_measure" },
            ...(transport === "native" ? { toolSignal: new AbortController().signal, respond: async (content: string) => { nativeResponse = content; } } : {}) };
          if (transport === "api") { yield { type: "completed", finishReason: "tool_calls" }; return; }
        }
        if (calls <= 2) {
          replies.push(nativeResponse ?? messages.findLast(message => message.role === "tool")?.content ?? "");
          yield { type: "computation-tool", toolCallId: "actual-measure", tool: { kind: "text-measure", text: "正文" },
            ...(transport === "native" ? { toolSignal: new AbortController().signal, respond: async () => {} } : {}) };
          if (transport === "api") { yield { type: "completed", finishReason: "tool_calls" }; return; }
        }
        yield { type: "delta", text: "已完成文字计数。" };
        yield { type: "completed", finishReason: "stop" };
      },
    };
    const f = fixture(provider), actor = f.repository.createBot();
    const sent = f.worker.send({ sessionId: actor.session.id, clientNonce: crypto.randomUUID(), text: "请用 text_measure 测量正文。" });
    await expect.poll(() => ["completed", "failed"].includes(f.repository.getRuntimeRun(sent.runId).state)).toBe(true);
    expect(f.repository.getRuntimeRun(sent.runId)).toMatchObject({ state: "completed", lastErrorCode: null });
    expect(JSON.parse(replies[0]!)).toMatchObject({ ok: false, recovery: { toolName: "text_measure", inputSchema: { required: ["text"] } } });
    expect(replies[0]).toContain("独立工具");
    const invocations = f.repository.listToolInvocations(actor.session.id);
    expect(invocations.filter(tool => tool.toolKind === "text-measure")).toHaveLength(1);
    const wrongEntry = invocations.find(tool => tool.toolCallId === "wrong-entry");
    // execute rejects the wrapped call before it is recorded, describe records the failure; neither may look successful.
    expect(wrongEntry?.state ?? "rejected-before-record").not.toBe("succeeded");
    if (action === "describe") expect(wrongEntry).toMatchObject({ state: "failed" });
  });

  it("finishes the prohibited-action diagnostic after a real empty browser status, without writes or input", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async *run() {
        yield { type: "started", requestId: `read-only-${++calls}` };
        if (calls === 1) {
          yield { type: "project-tool", toolCallId: "existing-status", tool: call("browser.get") };
          yield { type: "completed", finishReason: "tool_calls" };
        } else {
          yield { type: "delta", text: "当前没有已创建的浏览器，已停止诊断。" };
          yield { type: "completed", finishReason: "stop" };
        }
      },
      testConnection: async () => {},
    };
    const f = fixture(provider), actor = f.repository.createBot();
    const browser = new BrowserService(f.repository, { isAvailable: () => true, encrypt: value => value, decrypt: value => value }, f.root, join(f.root, "media"), undefined as unknown as EnvironmentService);
    f.dependencies.browserService = browser;
    try {
      const sent = f.worker.send({ sessionId: actor.session.id, clientNonce: crypto.randomUUID(), text: "阶段一 P4 只读诊断：只查询你当前已有的内置浏览器状态，并用 browser.observe 读取先前页面。不得启动或重启、导航、输入、截图、接管、外发或文件写入；不要通过 execution 绕过。若当前归用户控制，只报告该状态并停止。" });
      await expect.poll(() => ["completed", "failed"].includes(f.repository.getRuntimeRun(sent.runId).state)).toBe(true);
      expect(f.repository.getRuntimeRun(sent.runId)).toMatchObject({ state: "completed", lastErrorCode: null });
      expect(f.repository.listToolInvocations(actor.session.id)).toMatchObject([{ state: "succeeded", arguments: { operation: "browser.get" } }]);
      expect(f.repository.listToolInvocations(actor.session.id)).toHaveLength(1);
    } finally { await f.worker.shutdown(); await browser.shutdown(); }
  });
  it("accepts the original scenario's revision-qualified character metadata reply without an unrelated measurement", async () => {
    let calls = 0;
    const provider: ModelProvider = {
      async *run() {
        yield { type: "started", requestId: `original-metadata-${++calls}` };
        if (calls === 1) {
          yield { type: "project-tool", toolCallId: "read-document", tool: call("documents.read", { id: document.resource.id }) };
          yield { type: "completed", finishReason: "tool_calls" };
        } else {
          yield { type: "delta", text: `资料 revision \`${document.revision.id}\`：\`documents.read\` 成功，862 字符，\`truncated:false\`。` };
          yield { type: "completed", finishReason: "stop" };
        }
      },
      testConnection: async () => {},
    };
    const f = fixture(provider), actor = f.repository.createBot();
    const document = f.libraryService.create({ sessionId: actor.session.id, kind: "document", name: "Source metadata", body: "a".repeat(862) });
    const sent = f.worker.send({ sessionId: actor.session.id, clientNonce: crypto.randomUUID(), text: "读取绑定资料，只引用读取回执元数据，不重新计算文本。" });
    await expect.poll(() => ["completed", "failed"].includes(f.repository.getRuntimeRun(sent.runId).state)).toBe(true);
    expect(f.repository.listToolInvocations(actor.session.id)).toMatchObject([{ state: "succeeded", resultMetadata: { measurementResource: document.revision.id, measurementCharacters: 862 } }]);
    expect(f.repository.getRuntimeRun(sent.runId)).toMatchObject({ state: "completed", lastErrorCode: null });
  });

  it.each<{
    name: string; reply: string; code: string | null; kind?: "document" | "skill"; content?: string;
    reading?: "none" | "previous-runtime" | "other-session" | "failed" | "describe";
    truncated?: boolean; both?: boolean; request?: string; measure?: boolean; delayBeforeReplyMs?: number;
  }>([
    { name: "actual S4 negated execution list", request: "S4：每位成员只做资料装载验收，不执行研究、创建文件或电脑操作。使用真实 documents.read 读取产品事实；再使用 skills.load 加载与你角色同名的执行规范。只回显各自实际读取的 resourceId、revisionId、fullLength 及一句职责，不作任何正文计数。", both: true, reply: "revision $revision：$operation 成功，fullLength $length。", code: null },
    { name: "actual S4 no-count output prohibition", request: "请读取本群资料并加载规范，然后一行职责，不复述规范未来动作，不输出自行计算字数。", both: true, reply: "revision $revision：$operation 成功，fullLength $length。", code: null },
    { name: "N1 original request", request: "读取绑定资料，这些长度只引用读取返回的 fullLength，不重新计算文本。", reply: "revision $revision：$operation 成功，$length 字符。", code: null },
    { name: "N1 actual S4 read receipt follow-up", request: "请本次实际重新 documents.read 读取产品事实。只回显实际resourceId、revisionId、fullLength及职责，明确纠正原回复。长度仅引用读取回执，不重新统计正文；不研究、不创建文件、不操作电脑。", reply: "revision $revision：$operation 成功，fullLength $length。", code: null },
    { name: "colon field", reply: "revision $revision：fullLength: $length。", code: null },
    { name: "actual S4 metadata bullet record", reply: "**$operation**\n- resourceId：$resource\n- revisionId：$revision\n- fullLength：$length，truncated=false，offset=0，nextOffset=null\n\n一句职责：制作封面。", code: null },
    { name: "metadata bullet wrong revision", reply: "**$operation**\n- resourceId：$resource\n- revisionId：$other\n- fullLength：$length", code: "TOOL_EVIDENCE_REQUIRED" },
    { name: "metadata bullet wrong operation", reply: "**skills.load**\n- resourceId：$resource\n- revisionId：$revision\n- fullLength：$length", code: "TOOL_EVIDENCE_REQUIRED" },
    { name: "metadata bullet separate prose count", reply: "**$operation**\n- resourceId：$resource\n- revisionId：$revision\n- fullLength：$length\n\n正文有 $length 个非空白字符。", code: "MEASUREMENT_EVIDENCE_REQUIRED" },
    { name: "quoted metadata count", reply: "revision `$revision`：fullLength：`$length`。", code: null },
    { name: "quoted wrong metadata count", reply: "revision `$revision`：fullLength：`99`。", code: "TOOL_EVIDENCE_REQUIRED" },
    { name: "equal field", reply: "revision $revision：fullLength=$length。", code: null },
    { name: "space field", reply: "revision $revision：fullLength $length。", code: null },
    { name: "field with character unit", reply: "revision $revision：fullLength $length 字符。", code: null },
    { name: "Skill metadata", kind: "skill", reply: "revision $revision：$operation 成功，$length 字符，truncated:false。", code: null },
    { name: "Markdown row", kind: "skill", reply: "| 资料 | revision `$revision` | `$operation` 成功，$length 字符，未截断 |", code: null },
    { name: "resource and revision row", reply: "| document $resource | revision $revision | $operation 成功，$length 字符 |", code: null },
    { name: "wrong revision", reply: "revision $other：$operation 成功，$length 字符。", code: "TOOL_EVIDENCE_REQUIRED" },
    { name: "wrong named revision beside valid ID", reply: "revision $other：$operation 成功，回执资源 $revision，$length 字符。", code: "TOOL_EVIDENCE_REQUIRED" },
    { name: "wrong value", reply: "revision $revision：$operation 成功，99 字符。", code: "TOOL_EVIDENCE_REQUIRED" },
    { name: "resource ID is not revision", reply: "revision $resource：$operation 成功，$length 字符。", code: "TOOL_EVIDENCE_REQUIRED" },
    { name: "wrong operation", reply: "revision $revision：skills.load 成功，$length 字符。", code: "TOOL_EVIDENCE_REQUIRED" },
    { name: "old Runtime receipt", reading: "previous-runtime", reply: "revision $revision：$operation 成功，$length 字符。", code: "TOOL_EVIDENCE_REQUIRED" },
    { name: "other session receipt", reading: "other-session", reply: "revision $revision：$operation 成功，$length 字符。", code: "TOOL_EVIDENCE_REQUIRED" },
    { name: "failed read", reading: "failed", reply: "revision $revision：$operation 成功，$length 字符。", code: "TOOL_EVIDENCE_REQUIRED" },
    { name: "describe is not read", reading: "describe", reply: "revision $revision：$operation 成功，$length 字符。", code: "TOOL_EVIDENCE_REQUIRED" },
    { name: "handwritten metadata", reading: "none", reply: '{"revision":"$revision","operation":"$operation","fullLength":99}', code: "TOOL_EVIDENCE_REQUIRED" },
    { name: "ambiguous revisions", both: true, reply: "revision $revision 与 $other：$operation 成功，$length 字符。", code: "TOOL_EVIDENCE_REQUIRED" },
    { name: "comma new count", reply: "revision $revision：$operation 成功，$length 字符，我写的正文 $length 个非空白字符。", code: "MEASUREMENT_EVIDENCE_REQUIRED" },
    { name: "semicolon new count", reply: "revision $revision：$operation 成功，$length 字符；正文 $length 个非空白字符。", code: "MEASUREMENT_EVIDENCE_REQUIRED" },
    { name: "newline new count", reply: "revision $revision：$operation 成功，$length 字符\n正文 $length 个非空白字符。", code: "MEASUREMENT_EVIDENCE_REQUIRED" },
    { name: "contrast new count", reply: "revision $revision：$operation 成功，$length 字符，但我写的文章 $length 个非空白字符。", code: "MEASUREMENT_EVIDENCE_REQUIRED" },
    { name: "plain article characters", reply: "revision $revision：$operation 成功，$length 字符，文章有 $length 字符。", code: "MEASUREMENT_EVIDENCE_REQUIRED" },
    { name: "article suffix", reply: "revision $revision：$operation 成功，生成 $length 字符的文章。", code: "MEASUREMENT_EVIDENCE_REQUIRED" },
    { name: "Unicode field", content: "A😀 B", reply: "revision $revision：fullLength 5。", code: null },
    { name: "Unicode attributed length", content: "A😀 B", reply: "revision $revision：$operation 成功，5 字符。", code: null, delayBeforeReplyMs: 1_500 },
    { name: "Unicode count differs", content: "A😀 B", reply: "revision $revision：$operation 成功，Unicode 字符数 5。", code: "MEASUREMENT_EVIDENCE_REQUIRED" },
    { name: "whitespace metric differs", content: "A😀 B", reply: "revision $revision：$operation 成功，5 个非空白字符。", code: "MEASUREMENT_EVIDENCE_REQUIRED" },
    { name: "truncated full length", truncated: true, reply: "revision $revision：$operation 成功，fullLength $length，truncated:true。", code: null },
    { name: "truncated page is not full count", truncated: true, reply: "revision $revision：$operation 成功，fullLength $length，本页有 $length 个非空白字符。", code: "MEASUREMENT_EVIDENCE_REQUIRED" },
    { name: "abbreviated revision", reply: "revision $short：$operation 成功，$length 字符。", code: "TOOL_EVIDENCE_REQUIRED" },
    { name: "cross paragraph reference", reply: "revision $revision\n$operation 成功，$length 字符。", code: "TOOL_EVIDENCE_REQUIRED" },
    { name: "no resource", reply: "读取结果 $length 字符。", code: "MEASUREMENT_EVIDENCE_REQUIRED" },
    { name: "explicit measurement required", request: "请读取资料后用 text_measure 精确计算字数。", reply: "revision $revision：$operation 成功，$length 字符。", code: "TASK_REQUIREMENTS_UNMET" },
    { name: "actual text measurement", measure: true, reply: "revision $revision：$operation 成功，$length 字符；文本有 2 个非空白字符。", code: null },
    { name: "ordinary reply", reply: "资料已就绪。", code: null },
    { name: "application-owned document read claim", reply: "已读取文件内容，以下结论依据这次返回的资料。", code: null },
    { name: "loaded Skill file read claim", kind: "skill", reply: "已读取文件内容，执行规范已加载。", code: null },
  ])("binds resource length claims: $name", async ({ reply, code, kind = "document", content = "a".repeat(17), reading, truncated, both, request, measure, delayBeforeReplyMs }) => {
    let calls = 0;
    const operation = kind === "skill" ? "skills.load" : "documents.read";
    const provider: ModelProvider = {
      async *run() {
        yield { type: "started", requestId: `length-claim-${++calls}` };
        if (calls === 1 && !["none", "previous-runtime", "other-session"].includes(reading ?? "")) {
          yield { type: "project-tool", toolCallId: "read", tool: reading === "describe"
            ? { kind: "product-call", action: "describe", operation }
            : call(reading === "failed" ? "skills.load" : operation, { id: document.resource.id, ...(truncated ? { maxCharacters: 2 } : {}) }) };
          if (both) yield { type: "project-tool", toolCallId: "read-other", tool: call(operation, { id: other.resource.id }) };
          yield { type: "completed", finishReason: "tool_calls" };
        } else if (calls === 2 && measure) {
          yield { type: "computation-tool", toolCallId: "measure", tool: { kind: "text-measure", text: "你好" } };
          yield { type: "completed", finishReason: "tool_calls" };
        } else {
          if (delayBeforeReplyMs) await new Promise(resolve => setTimeout(resolve, delayBeforeReplyMs));
          yield { type: "delta", text: reply.replaceAll("$revision", document.revision.id).replaceAll("$other", other.revision.id)
            .replaceAll("$resource", document.resource.id).replaceAll("$short", `${document.revision.id.slice(0, 8)}…${document.revision.id.slice(-5)}`)
            .replaceAll("$operation", operation).replaceAll("$length", String(content.length)) };
          yield { type: "completed", finishReason: "stop" };
        }
      },
      testConnection: async () => {},
    };
    const f = fixture(provider), actor = f.repository.createBot();
    const document = f.libraryService.create({ sessionId: reading === "other-session" ? f.actor.session.id : actor.session.id, kind, name: "source-metadata", body: content });
    const other = f.libraryService.create({ sessionId: actor.session.id, kind, name: "other-metadata", body: content });
    if (reading === "previous-runtime" || reading === "other-session") {
      const prior = reading === "other-session" ? f.runtime : libraryRuntime(f.repository, actor);
      await f.execute(call(operation, { id: document.resource.id }), prior.id);
      f.repository.transitionRuntimeRun(prior.id, "completed");
    }
    const started = vi.spyOn(f.worker.executor, "start");
    const sent = f.worker.send({ sessionId: actor.session.id, clientNonce: crypto.randomUUID(), text: request ?? "读取绑定资料，只引用读取回执元数据，不重新计算文本。" });
    expect(started).toHaveBeenCalledOnce();
    await started.mock.results[0]!.value.completion;
    expect(f.repository.getRuntimeRun(sent.runId)).toMatchObject({ state: code ? "failed" : "completed", lastErrorCode: code });
    const invocations = f.repository.listToolInvocations(actor.session.id).filter(item => item.runtimeRunId === sent.runId);
    expect(invocations.some(item => item.toolKind === "text-measure")).toBe(Boolean(measure));
    if (!reading) expect(invocations).toContainEqual(expect.objectContaining({ state: "succeeded", resultMetadata: expect.objectContaining({ measurementResource: document.revision.id, measurementCharacters: content.length, truncated: Boolean(truncated) }) }));
    if (reading === "failed") expect(invocations).toContainEqual(expect.objectContaining({ state: "failed" }));
  });

  it("retains screenshot identity and byte size without pixel data", async () => {
    const f = fixture();
    const media = { id: crypto.randomUUID(), name: "screenshot.jpg", size: 51648, sha256: "a".repeat(64), mimeType: "image/jpeg" };
    f.dependencies.browserService = { computerScreenshot: async () => ({ media }) } as unknown as BrowserService;
    const result = await f.execute(call("computer.screenshot", { expectedEpoch: 1 }));
    expect(f.repository.getToolInvocation(result.invocation.id).resultMetadata).toMatchObject({ measurementResource: media.id, measurementBytes: 51648, measurementDigest: media.sha256 });
    expect(JSON.stringify(f.repository.getToolInvocation(result.invocation.id).resultMetadata)).not.toContain("base64");
  });

  it("retains the verified isolated write path, digest and byte size", async () => {
    const f = fixture();
    const file = { path: "report.md", size: 8, sha256: "b".repeat(64), created: true };
    f.dependencies.environmentService = { writeFile: async () => file } as unknown as EnvironmentService;
    const result = await f.execute(call("execution.writeFile", { path: file.path, content: "evidence" }));
    expect(JSON.parse(result.content)).toMatchObject({ ok: true, status: "completed", result: file });
    expect(f.repository.getToolInvocation(result.invocation.id).resultMetadata).toMatchObject({
      status: "completed", operation: "execution.writeFile", measurementResource: file.path, measurementBytes: file.size, measurementDigest: file.sha256,
    });
  });

  it("retains the exact document revision and fullLength instead of measuring the truncated page", async () => {
    const f = fixture();
    const doc = f.libraryService.create({ sessionId: f.actor.session.id, kind: "document", name: "Size", body: "abcdef" });
    const result = await f.execute(call("documents.read", { id: doc.resource.id, maxCharacters: 2 }));
    expect(f.repository.getToolInvocation(result.invocation.id).resultMetadata).toMatchObject({ measurementResource: doc.revision.id, measurementCharacters: 6, measurementDigest: doc.revision.digest, truncated: true });
    expect(JSON.stringify(f.repository.getToolInvocation(result.invocation.id).resultMetadata)).not.toContain("abcdef");
  });
});

function libraryRuntime(repository: AppRepository, actor: ReturnType<AppRepository["createBot"]>, resourceRefs: ResourceReference[] = []) {
  const nonce = crypto.randomUUID();
  repository.prepareMessage({ sessionId: actor.session.id, clientNonce: nonce, text: "使用本轮资料", resourceRefs });
  const entry = repository.getUserMessage(nonce);
  const runtime = repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: actor.bot.id, profileVersion: actor.bot.version,
    sessionId: actor.session.id, generation: actor.session.generation, inputSeq: entry.seq, blocks: [], digest: "library-tool-test" });
  repository.transitionRuntimeRun(runtime.id, "dispatching");
  return repository.transitionRuntimeRun(runtime.id, "running", { providerRequestId: "library-tool-test" });
}

describe("media product transport", () => {
  it("shares scoped UI handlers but keeps AI text outside durable tool receipts and rechecks revocation", async () => {
    const f = fixture();
    const text = "PRIVATE_EXTRACTED_TEXT";
    const parser: MediaParserAdapter = {
      parse: async () => ({ kind: "pdf", width: null, height: null, parserName: "controlled-unit-parser", parserVersion: "1",
        extraction: { text, spans: [{ kind: "page", index: 0, start: 0, end: text.length }], warningCodes: [] } }),
      renderPdfPage: async () => { throw new Error("not used"); }, shutdown: async () => {},
    };
    const media = new MediaService(f.repository, join(f.root, "media"), parser);
    const source = join(f.root, "private.pdf"); writeFileSync(source, "%PDF-1.7 controlled unit fixture");
    try {
      const item = (await media.importPaths(f.actor.session.id, [source])).imported[0]!;
      f.repository.transitionRuntimeRun(f.runtime.id, "completed");
      const runtime = libraryRuntime(f.repository, f.actor);
      f.dependencies.mediaService = media;
      const service = new ProductOperationService(f.dependencies);
      f.executor.setProductOperations(service);
      const tool = call("media.read", { id: item.reference.mediaId });
      const prepared = f.repository.prepareToolInvocation({ runtimeRunId: runtime.id, toolCallId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), tool });
      f.repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
      const result = await f.executor.execute(prepared.invocation.id);
      expect(result.modelText?.text).toBe(text);
      expect(result.modelText?.isAuthorized()).toBe(true);
      expect(result.content).not.toContain(text);
      expect(JSON.stringify(f.repository.getToolInvocation(prepared.invocation.id))).not.toContain(text);
      expect(service.requiresApproval(call("media.available"))).toBe(true);
      expect(service.requiresApproval(tool)).toBe(false);
      const ui = await service.handlers.get("media:read")!({ sessionId: f.actor.session.id, id: item.reference.mediaId });
      expect(ui).toMatchObject({ text });
      const other = f.repository.createBot();
      expect(() => service.validate(call("media.read", { sessionId: other.session.id, id: item.reference.mediaId }), runtime.id)).toThrow();
      media.unbind({ sessionId: f.actor.session.id, id: item.reference.mediaId });
      expect(result.modelText?.isAuthorized()).toBe(false);
      expect(() => service.validate(tool, runtime.id)).toThrow();
    } finally { await media.shutdown(); }
  });
});

describe("draft view Runtime boundary", () => {
  const actions = ["draft_get", "draft_update", "draft_remove_attachment", "draft_add_attachments"] as const;

  it.each(actions)("binds %s without a supplied session to the executing Runtime", async action => {
    const f = fixture(), requestView = vi.fn(async () => ({ status: "completed" as const,
      result: { sessionId: f.actor.session.id, text: "CONTROLLED_OWN_SESSION_DRAFT" } }));
    f.dependencies.requestView = requestView;
    const result = await f.execute(call("view.request", { action }));
    expect(JSON.parse(result.content)).toMatchObject({ ok: true, result: { sessionId: f.actor.session.id } });
    expect(requestView).toHaveBeenCalledTimes(1);
    expect(requestView).toHaveBeenCalledWith(expect.objectContaining({ action, sessionId: f.actor.session.id }));
  });

  it.each(actions)("rejects %s targeting a different private session before forwarding to the Renderer", action => {
    const f = fixture(), foreign = f.repository.createBot(), requestView = vi.fn();
    f.dependencies.requestView = requestView;
    expect(() => f.service.validate(call("view.request", { action, sessionId: foreign.session.id }), f.runtime.id))
      .toThrowError(expect.objectContaining({ code: "PRODUCT_VIEW_SCOPE_INVALID" }));
    expect(requestView).not.toHaveBeenCalled();
    expect(f.repository.listToolInvocations(f.actor.session.id)).toEqual([]);
  });

  it("does not replay a legacy draft receipt from another open conversation", async () => {
    const f = fixture(), foreign = f.repository.createBot();
    const tool = call("view.request", { action: "draft_get" });
    const legacy = f.prepare(tool);
    f.repository.resolveToolApproval(legacy.approval.id, legacy.approval.version, "allow-once");
    f.repository.transitionToolInvocation(legacy.invocation.id, "dispatching");
    f.repository.transitionToolInvocation(legacy.invocation.id, "running");
    f.repository.completeProductToolInvocation(legacy.invocation.id, "0".repeat(64), JSON.stringify({ ok: true, status: "completed",
      result: { sessionId: foreign.session.id, text: "CONTROLLED_LEGACY_FOREIGN_DRAFT" } }), {});
    const requestView = vi.fn(async () => ({ status: "waiting_user" as const, reason: "请先打开指定聊天。" }));
    f.dependencies.requestView = requestView;
    const result = await f.execute(tool);
    expect(JSON.parse(result.content)).toMatchObject({ ok: true, status: "waiting_user" });
    expect(result.content).not.toContain("CONTROLLED_LEGACY_FOREIGN_DRAFT");
    expect(requestView).toHaveBeenCalledWith({ action: "draft_get", sessionId: f.actor.session.id });
  });

  it("retains private draft-read approval while ordinary settings navigation and computer use stay direct", async () => {
    const f = fixture(), requestView = vi.fn(async () => ({ status: "completed" as const }));
    f.dependencies.requestView = requestView;
    expect(f.service.requiresApproval(call("view.request", { action: "open_settings" }))).toBe(false);
    expect(f.service.requiresApproval(call("browser.start"))).toBe(false);
    const controller = new AbortController();
    const pending = f.coordinator.requestAndWait(f.runtime.id, "private-draft-read", call("view.request", { action: "draft_get" }), controller.signal);
    try {
      const invocation = f.repository.listToolInvocations(f.actor.session.id).at(-1)!;
      const approval = f.repository.getApprovalRequest(invocation.approvalRequestId);
      expect(approval.state).toBe("pending");
      expect(requestView).not.toHaveBeenCalled();
      await f.coordinator.resolve(f.actor.session.id, approval.id, approval.version, "deny");
      expect(JSON.parse((await pending).content)).toMatchObject({ ok: false, error: { code: "TOOL_DENIED" } });
      expect(requestView).not.toHaveBeenCalled();
    } finally { controller.abort(); await pending.catch(() => undefined); }
  });
});

describe("product operations", () => {
  it("executes routine settings directly without emitting an approval request", async () => {
    const f = fixture(), events: import("@shared/contracts").ToolEvent[] = [];
    const coordinator = new WorkspaceToolCoordinator(f.repository, f.executor, event => events.push(event));
    const controller = new AbortController();
    const pending = coordinator.requestAndWait(f.runtime.id, "direct-settings", call("settings.saveGeneral", { theme: "dark" }), controller.signal);
    try {
      const invocation = f.repository.listToolInvocations(f.actor.session.id).at(-1)!;
      expect(f.repository.getApprovalRequest(invocation.approvalRequestId).state).toBe("allowed");
      await pending;
      expect(f.dependencies.generalSettings.getConfiguration().theme).toBe("dark");
      expect(events.some(event => event.invocation.state === "awaiting-approval")).toBe(false);
      expect(f.repository.getToolInvocation(invocation.id).state).toBe("succeeded");
    } finally { controller.abort(); await pending.catch(() => undefined); }
  });

  it("starts the Bot computer directly through the shared gateway and retains its scope", async () => {
    const f = fixture(), start = vi.fn(async () => ({ state: "running" }));
    f.dependencies.browserService = { start } as unknown as NonNullable<ProductDependencies["browserService"]>;
    const controller = new AbortController();
    const pending = f.coordinator.requestAndWait(f.runtime.id, "direct-computer", call("browser.start"), controller.signal);
    try {
      const invocation = f.repository.listToolInvocations(f.actor.session.id).at(-1)!;
      expect(f.repository.getApprovalRequest(invocation.approvalRequestId).state).toBe("allowed");
      await pending;
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ sessionId: f.actor.session.id, executorBotId: f.actor.bot.id }),
        expect.objectContaining({ actor: "ai", runtimeRunId: f.runtime.id }));
      const other = f.repository.createBot();
      expect(() => f.coordinator.requestAndWait(f.runtime.id, "foreign-computer", call("browser.start", { sessionId: other.session.id }), controller.signal)).toThrow();
      expect(start).toHaveBeenCalledTimes(1);
      const description = JSON.parse((await f.execute({ kind: "product-call", action: "describe", operation: "browser.navigate" })).content);
      expect(description.approvalRequired).toBe(false);
    } finally { controller.abort(); await pending.catch(() => undefined); }
  });

  it.each([undefined, "false"])("honors the public-read default and persisted opt-out (%s)", async setting => {
    const f = fixture();
    if (setting !== undefined) f.repository.setSetting("tools.autoApprovePublicRead", setting, false);
    const events: import("@shared/contracts").ToolEvent[] = [];
    const executor = new WorkspaceToolExecutor(f.repository, f.dependencies.workspaceService, new NetworkToolExecutor());
    const coordinator = new WorkspaceToolCoordinator(f.repository, executor, event => events.push(event));
    const outcome = coordinator.requestAndWait(f.runtime.id, "public-default", { kind: "time-now", timezone: "UTC" }, new AbortController().signal);
    const invocation = f.repository.listToolInvocations(f.actor.session.id).at(-1)!;
    const approval = f.repository.getApprovalRequest(invocation.approvalRequestId);
    if (setting === "false") {
      expect(approval.state).toBe("pending");
      await coordinator.resolve(f.actor.session.id, approval.id, approval.version, "deny");
      expect(JSON.parse((await outcome).content)).toMatchObject({ ok: false, error: { code: "TOOL_DENIED" } });
      expect(f.repository.getToolInvocation(invocation.id).attemptCount).toBe(0);
    } else {
      expect(approval.state).toBe("allowed");
      await outcome;
      expect(f.repository.getToolInvocation(invocation.id).state).toBe("succeeded");
      expect(events.some(event => event.invocation.state === "awaiting-approval")).toBe(false);
    }
  });

  it("retains approval for permission changes and disruptive environment actions", () => {
    const f = fixture();
    for (const operation of ["environments.stop", "environments.rebuild", "conversations.setProject"]) expect(f.service.requiresApproval(call(operation))).toBe(true);
    expect(f.service.requiresApproval(call("approvals.resolve"))).toBe(true);
    expect(f.service.requiresApproval(call("providers.saveCli"))).toBe(true);
    expect(f.service.requiresApproval(call("outbound.send"))).toBe(true);
    expect(f.service.requiresApproval(call("view.request", { action: "app_exit" }))).toBe(true);
    expect(f.service.requiresApproval(call("bots.update", { patch: { mcpServerIds: [] } }))).toBe(true);
    expect(f.service.requiresApproval(call("bots.update", { patch: { memoryWorkspaceIds: [] } }))).toBe(true);
    for (const launchAtLogin of [true, false]) expect(f.service.requiresApproval(call("settings.saveGeneral", { launchAtLogin }))).toBe(true);
    f.repository.setSetting("memory.capture.enabled", "false", false);
    expect(f.service.requiresApproval(call("settings.saveGeneral", { memoryCaptureEnabled: true }))).toBe(true);
    expect(f.service.requiresApproval(call("settings.saveGeneral", { memoryCaptureEnabled: false }))).toBe(false);
    expect(f.service.requiresApproval(call("settings.saveGeneral", { theme: "dark" }))).toBe(false);
  });

  it("creates a requested Bot after clarification without another approval step", async () => {
    const provider: ModelProvider = {
      async *run(messages) {
        yield { type: "started", requestId: "product-follow-up" };
        if (messages.at(-1)?.role !== "tool") yield { type: "project-tool", toolCallId: "product-create", tool: call("bots.create") };
        else yield { type: "delta", text: "已创建一个 Bot。" };
        yield { type: "completed", finishReason: "stop" };
      },
      testConnection: async () => {},
    };
    const f = fixture(provider), actor = f.repository.createBot();
    const sent = f.worker.send({ sessionId: actor.session.id, clientNonce: crypto.randomUUID(), text: "自媒体选题吧" });
    await expect.poll(() => f.repository.getRuntimeRun(sent.runId).state).toBe("completed");
    expect(f.repository.listBots()).toHaveLength(3);
    expect(f.repository.listToolInvocations(actor.session.id).at(-1)?.state).toBe("succeeded");
    expect(f.repository.listPendingApprovalRequests(actor.session.id)).toEqual([]);
  });

  it("discovers every UI operation and describes actual field constraints without keyword gating", async () => {
    const f = fixture();
    const catalog = JSON.parse((await f.execute({ kind: "product-call", action: "catalog" })).content);
    expect(catalog.operations).toHaveLength(PRODUCT_OPERATIONS.length);
    expect(new Set(catalog.operations.map((op: { name: string }) => op.name))).toEqual(new Set(PRODUCT_OPERATIONS.map((op) => op.name)));
    const description = JSON.parse((await f.execute({ kind: "product-call", action: "describe", operation: "settings.saveGeneral" })).content);
    expect(description.inputSchema.properties.theme.enum).toEqual(["system", "light", "dark"]);
    expect(description.approvalRequired).toBe(false);
    expect(JSON.stringify(catalog)).not.toContain('"channel"');
  });
  it("does not discover or execute retired workspace setup operations even when old directories remain", async () => {
    const f = fixture();
    const registered = await f.dependencies.workspaceService.registerRoot(f.root);
    const retired = ["workspaces.list", "workspaces.add", "workspaces.updatePermissions", "workspaces.reveal", "workspaces.remove", "projects.list", "projects.create", "conversations.setProject", "teams.createContentTeam", "library.importPath", "documents.import", "skills.import", "media.importPath"];
    const catalog = JSON.parse((await f.execute({ kind: "product-call", action: "catalog" })).content) as { operations: Array<{ name: string }> };
    for (const operation of retired) {
      expect(catalog.operations.some(item => item.name === operation)).toBe(false);
      expect(PRODUCT_OPERATION_SCHEMAS[operation]).toBeUndefined();
      await expect(f.execute({ kind: "product-call", action: "describe", operation })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    for (const channel of [IPC.workspacesList, IPC.workspacesAdd, IPC.workspacesUpdatePermissions, IPC.workspacesReveal, IPC.workspacesRemove, IPC.projectsList, IPC.projectsCreate, IPC.conversationsSetProject, IPC.teamsCreateContentTeam]) {
      expect(f.service.handlers.has(channel)).toBe(false);
    }
    expect(f.repository.getWorkspace(registered.workspace.id).removedAt).toBeNull();
    expect(f.repository.listBots()).toHaveLength(1);
    expect(f.repository.listRooms()).toEqual([]);
  });

  it("rejects retired navigation, directory memory and project parameters before dispatch", () => {
    const f = fixture();
    expect(PRODUCT_OPERATION_SCHEMAS["view.request"]!.safeParse({ action: "open_workspaces" }).success).toBe(false);
    for (const group of ["workspaces", "project", "bot_group", "room_group"]) {
      expect(PRODUCT_OPERATION_SCHEMAS["view.request"]!.safeParse({ action: "sidebar_expand", group }).success).toBe(false);
    }
    expect(PRODUCT_OPERATION_SCHEMAS["memories.list"]!.safeParse({ scope: "workspace", scopeKey: crypto.randomUUID() }).success).toBe(false);
    expect(PRODUCT_OPERATION_SCHEMAS["memories.list"]!.safeParse({ scope: "user", scopeKey: "user", includeDeleted: true }).success).toBe(true);
    expect(PRODUCT_OPERATION_SCHEMAS["memories.create"]!.safeParse({ scope: "user", scopeKey: "user", content: "保留用户偏好。" }).success).toBe(true);
    expect(PRODUCT_OPERATION_SCHEMAS["memories.create"]!.safeParse({ scope: "bot", scopeKey: f.actor.bot.id, content: "保留 Bot 记忆。" }).success).toBe(true);
    expect(PRODUCT_OPERATION_SCHEMAS["bots.update"]!.safeParse({ id: f.actor.bot.id, expectedVersion: 1, patch: { memoryWorkspaceIds: [] } }).success).toBe(false);
    expect(PRODUCT_OPERATION_SCHEMAS["bots.create"]!.safeParse({ projectId: crypto.randomUUID() }).success).toBe(false);
    expect(f.repository.listToolInvocations(f.actor.session.id)).toEqual([]);
  });

  it("cannot reopen an old pending directory approval or read its target", async () => {
    const f = fixture();
    writeFileSync(join(f.root, "legacy.md"), "PRIVATE_LEGACY_FILE", "utf8");
    const registered = await f.dependencies.workspaceService.registerRoot(f.root);
    const actor = f.repository.createBot(registered.project.id);
    const nonce = crypto.randomUUID();
    f.repository.prepareMessage({ sessionId: actor.session.id, clientNonce: nonce, text: "Historical pending request" });
    const run = f.repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: actor.bot.id, profileVersion: 1, sessionId: actor.session.id, generation: 1, inputSeq: 1, blocks: [], digest: "legacy-approval" });
    f.repository.transitionRuntimeRun(run.id, "dispatching");
    f.repository.transitionRuntimeRun(run.id, "running", { providerRequestId: "legacy" });
    const pending = f.repository.prepareToolInvocation({ runtimeRunId: run.id, toolCallId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), tool: { kind: "workspace-read", workspaceId: registered.workspace.id, path: "legacy.md", maxBytes: 100 } });
    expect(f.repository.getApprovalRequest(pending.approval.id).state).toBe("pending");
    expect(f.service.handlers.get(IPC.approvalsListPending)!({ sessionId: actor.session.id })).toEqual([]);
    await expect(f.service.handlers.get(IPC.approvalsResolve)!({ sessionId: actor.session.id, id: pending.approval.id, expectedVersion: pending.approval.version, resolution: "allow-once" })).rejects.toMatchObject({ code: "LOCAL_DIRECTORY_ACCESS_REMOVED" });
    expect(f.repository.getToolInvocation(pending.invocation.id)).toMatchObject({ attemptCount: 0, resultDigest: null, state: "awaiting-approval" });
    expect(readFileSync(join(f.root, "legacy.md"), "utf8")).toBe("PRIVATE_LEGACY_FILE");
  });

  it("requires the recorded host decision before executor mutation and records the persisted value", async () => {
    const f = fixture();
    const pending = f.prepare(call("settings.saveGeneral", { theme: "dark" }));
    await expect(f.executor.execute(pending.invocation.id)).rejects.toMatchObject({ code: "TOOL_STATE_INVALID" });
    expect(f.dependencies.generalSettings.getConfiguration().theme).toBe("system");
    f.repository.resolveToolApproval(pending.approval.id, pending.approval.version, "allow-once");
    const changed = await f.executor.execute(pending.invocation.id);
    expect(JSON.parse(changed.content)).toMatchObject({ status: "completed", result: { theme: "dark" } });
    expect(changed.invocation.effectClass).toBe("write-reversible");
    expect(f.dependencies.generalSettings.getConfiguration().theme).toBe("dark");
  });
  it("rejects the retired content template without creating resources", async () => {
    const f = fixture();
    await expect(f.execute(call("teams.createContentTeam", {}))).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(f.repository.listBots()).toHaveLength(1);
    expect(f.repository.listRooms()).toHaveLength(0);
  });
  it("normalizes defaults and JSON field order before mutating requests are journaled", async () => {
    const f = fixture();
    const first = await f.execute(call("bots.create"));
    const second = await f.execute(call("bots.create", {}));
    expect(second.content).toEqual(first.content);
    const a = await f.execute(call("settings.saveGeneral", { theme: "dark", memoryCaptureEnabled: false }));
    const b = await f.execute(call("settings.saveGeneral", { memoryCaptureEnabled: false, theme: "dark" }));
    expect(b.content).toEqual(a.content);
    expect(f.repository.listBots()).toHaveLength(2);
    const unknown = f.prepare(call("bots.create", {}));
    f.repository.resolveToolApproval(unknown.approval.id, unknown.approval.version, "allow-once");
    f.repository.transitionToolInvocation(unknown.invocation.id, "dispatching");
    f.repository.transitionToolInvocation(unknown.invocation.id, "running");
    const raw = new DatabaseSync(join(f.root, "app.sqlite"));
    raw.prepare("UPDATE tool_invocations SET state = 'interrupted-unknown' WHERE id = ?").run(unknown.invocation.id); raw.close();
    expect(() => f.repository.assertProductReplaySafe(f.runtime.clientNonce, call("bots.create", null))).toThrow();
  });
  it("shares the creation budget with legacy tools and does not count reused resources", async () => {
    const f = fixture();
    await f.execute(call("bots.create", {}));
    const legacy = (name: string) => {
      const prepared = f.repository.prepareToolInvocation({ runtimeRunId: f.runtime.id, toolCallId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), tool: { kind: "bot-create", name, label: "", description: "", instructions: "" } });
      f.repository.resolveToolApproval(prepared.approval.id, prepared.approval.version, "allow-once");
      f.repository.transitionToolInvocation(prepared.invocation.id, "dispatching");
      f.repository.transitionToolInvocation(prepared.invocation.id, "running");
      return f.repository.executeProjectCreation(prepared.invocation.id);
    };
    legacy("one"); legacy("one");
    for (const name of ["two", "three", "four", "five", "six", "seven"]) legacy(name);
    expect(f.repository.productResourceCount(f.runtime.clientNonce)).toBe(8);
    expect(() => legacy("eight")).toThrowError(expect.objectContaining({ code: "PROJECT_CREATION_LIMIT" }));
  });
  it("updates only the nickname while keeping the locally stored avatar", async () => {
    const f = fixture();
    const chunk = (type: string, bytes: Buffer) => {
      const block = Buffer.alloc(bytes.length + 12); block.writeUInt32BE(bytes.length); block.write(type, 4); bytes.copy(block, 8);
      let crc = 0xffffffff;
      for (const byte of block.subarray(4, -4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
      block.writeUInt32BE((crc ^ 0xffffffff) >>> 0, block.length - 4); return block;
    };
    const header = Buffer.alloc(13); header.writeUInt32BE(256); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = 6;
    const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(256 * (256 * 4 + 1)))), chunk("IEND", Buffer.alloc(0))]);
    const profile = new UserProfileService(f.repository);
    profile.update({ name: "原名", avatarUrl: `data:image/png;base64,${png.toString("base64")}` });
    const before = profile.get().avatarUrl;
    const output = await f.execute(call("userProfile.update", { name: "新名" }));
    expect(JSON.parse(output.content).result).toEqual({ name: "新名", hasAvatar: true });
    expect(output.content).not.toContain("data:image/");
    expect(profile.get()).toEqual({ name: "新名", avatarUrl: before });
  });
  it("cancels live descendants even after the intermediate sender has completed", () => {
    const f = fixture();
    const child = (parent: typeof f.runtime, depth: number) => {
      const bot = f.repository.createBot(); const nonce = crypto.randomUUID();
      f.repository.prepareMessage({ sessionId: bot.session.id, clientNonce: nonce, text: "委派任务" }, { kind: "ai-delegation", fromBotId: parent.executorBotId, fromSessionId: parent.sessionId, fromRuntimeRunId: parent.id, rootClientNonce: f.runtime.clientNonce, depth, ancestorRunIds: ["forged"] });
      const run = f.repository.createRuntimeRun(nonce, "fake", { schemaVersion: 1, botId: bot.bot.id, profileVersion: 1, sessionId: bot.session.id, generation: 1, inputSeq: 1, blocks: [], digest: "delegation-test" });
      f.repository.transitionRuntimeRun(run.id, "dispatching");
      return f.repository.transitionRuntimeRun(run.id, "running", { providerRequestId: "test" });
    };
    const b = child(f.runtime, 1); const c = child(b, 2);
    expect(f.repository.getUserMessage(c.clientNonce).origin?.ancestorRunIds).toEqual([f.runtime.id, b.id]);
    f.repository.transitionRuntimeRun(b.id, "completed");
    f.worker.executor.setDelegationCancellation((id) => { for (const item of f.repository.listDelegatedRuntimeRuns(id)) f.worker.executor.cancelRun(item.id); });
    f.worker.executor.cancelRun(b.id);
    expect(f.repository.getRuntimeRun(c.id).state).toBe("cancel-requested");
    expect(f.repository.listDelegatedRuntimeRuns(f.runtime.id).map((item) => item.id)).toContain(c.id);
  });
  it("schedules an approved update instead of blocking on the source Runtime", async () => {
    const f = fixture();
    f.dependencies.requestUpdateAfterRun = vi.fn(() => ({ status: "running" as const, result: { scheduled: true } }));
    expect(JSON.parse((await f.execute(call("updates.installAndRestart"))).content)).toMatchObject({ status: "running", result: { scheduled: true } });
    expect(f.dependencies.requestUpdateAfterRun).toHaveBeenCalledWith(f.runtime.id);
  });
  it("rolls a new Bot back if the success receipt fails to commit", async () => {
    const f = fixture();
    const raw = new DatabaseSync(join(f.root, "app.sqlite"));
    raw.exec("CREATE TRIGGER reject_product_success BEFORE UPDATE OF state ON tool_invocations WHEN NEW.state = 'succeeded' BEGIN SELECT RAISE(ABORT, 'receipt failed'); END;");
    raw.close();
    await expect(f.execute(call("bots.create", {}))).rejects.toMatchObject({ code: "TOOL_EXECUTION_FAILED" });
    expect(f.repository.listBots()).toHaveLength(1);
    expect(f.repository.listRooms()).toHaveLength(0);
  });
  it("keeps private metadata and folder paths out of automatic directory reads", async () => {
    const f = fixture();
    const other = f.repository.createBot();
    f.repository.updateBot(other.bot.id, other.bot.version, { instructions: "private role instructions" });
    const output = JSON.parse((await f.execute(call("bots.list"))).content);
    expect(output.result).toHaveLength(2);
    expect(JSON.stringify(output)).not.toContain("private role instructions");
    expect(f.service.requiresApproval(call("transcript.list", other.session.id))).toBe(true);
  });
  it("rejects unknown actions, model-supplied identity and raw API credentials before execution", () => {
    const f = fixture();
    expect(() => f.service.validate(call("system.shell", {}), f.runtime.id)).toThrow();
    expect(() => f.service.validate(call("capabilities.getSnapshot", { botId: crypto.randomUUID() }), f.runtime.id)).toThrow();
    expect(() => f.service.validate(call("providers.saveOpenAiCompatible", { instanceId: "openai-compatible.default", expectedVersion: 1, baseUrl: "https://example.com/v1", apiKey: "do-not-log-this" }), f.runtime.id)).toThrow();
  });
  it("forwards an exact genuine user decision but never grants approval without it", async () => {
    const f = fixture();
    f.repository.setSetting("tools.autoApprovePublicRead", "false", false);
    const waiting = f.coordinator.requestAndWait(f.runtime.id, "target-permission", call("settings.saveGeneral", { autoApprovePublicReadTools: true }), new AbortController().signal);
    const target = f.repository.listPendingApprovalRequests(f.actor.session.id)[0]!;
    const requested = f.prepare(call("approvals.resolve", { sessionId: f.actor.session.id, id: target.id, expectedVersion: target.version, resolution: "allow-once" }));
    await expect(f.executor.execute(requested.invocation.id)).rejects.toMatchObject({ code: "TOOL_STATE_INVALID" });
    expect(f.repository.getApprovalRequest(target.id).state).toBe("pending");
    f.repository.resolveToolApproval(requested.approval.id, requested.approval.version, "allow-once");
    const output = JSON.parse((await f.executor.execute(requested.invocation.id)).content);
    expect(output.status).toBe("completed");
    expect(JSON.parse((await waiting).content).result.autoApprovePublicReadTools).toBe(true);
    expect(f.repository.getApprovalRequest(target.id).state).toBe("allowed");
  });

  it("returns only the owned group batch and its real member replies", async () => {
    const provider: ModelProvider = { async *run() { yield { type: "started", requestId: "member" }; yield { type: "delta", text: "成员测试回复" }; yield { type: "completed", finishReason: "stop" }; }, testConnection: async () => {} };
    const f = fixture(provider);
    const b = f.repository.createBot(); const c = f.repository.createBot();
    const room = f.repository.createRoom({ memberBotIds: [b.bot.id, c.bot.id], name: "委派测试群" });
    const sent = JSON.parse((await f.execute(call("roomRuntime.send", { roomId: room.room.id, sessionId: room.session.id, text: "请回复问候", targetBotIds: [b.bot.id, c.bot.id], routingMode: "explicit" }))).content);
    const output = JSON.parse((await f.execute(call("tasks.waitRoomResult", { batchId: sent.result.batchId, timeoutMs: 5_000 }))).content);
    expect(output.result.state).toBe("completed");
    expect(output.result.replies).toHaveLength(2);
    expect(output.result.replies.every((reply: { response: { body: string } }) => reply.response.body === "成员测试回复")).toBe(true);
    const other = f.repository.createRoom({ memberBotIds: [f.actor.bot.id, b.bot.id] });
    const run = await f.dependencies.roomCoordinator.routeAndSend({ roomId: other.room.id, sessionId: other.session.id, clientNonce: crypto.randomUUID(), text: "其他群任务", targetBotIds: [b.bot.id], routingMode: "explicit" });
    expect(() => f.service.validate(call("tasks.getRoomResult", { batchId: run.batchId }), f.runtime.id)).toThrow();
    await f.worker.shutdown(); await f.dependencies.roomCoordinator.shutdown();
  });
  it("returns invalid product parameters to the model so it can recover without failing the Runtime", async () => {
    let round = 0;
    const outcomes: string[] = [];
    const provider: ModelProvider = { async *run(messages) {
      outcomes.push(JSON.stringify(messages)); yield { type: "started", requestId: "validation-recovery" };
      round += 1;
      if (round <= 2) {
        yield { type: "project-tool", toolCallId: `recovery-${round}`, providerToolName: round === 1 ? "product_execute" : "product_catalog", tool: round === 1 ? call("settings.saveGeneral", { theme: "purple" }) : { kind: "product-call", action: "catalog" } };
        yield { type: "completed", finishReason: "tool_calls" };
      } else { yield { type: "delta", text: "已取得实际功能目录" }; yield { type: "completed", finishReason: "stop" }; }
    }, testConnection: async () => {} };
    const f = fixture(provider); const bot = f.repository.createBot();
    const sent = f.worker.send({ sessionId: bot.session.id, clientNonce: crypto.randomUUID(), text: "查询产品功能目录" });
    await expect.poll(() => f.repository.getRuntimeRun(sent.runId).state).toBe("completed");
    expect(outcomes.at(-1)).toContain("INVALID_REQUEST");
    expect(f.repository.listPendingApprovalRequests(bot.session.id)).toEqual([]);
    expect(f.dependencies.generalSettings.getConfiguration().theme).toBe("system");
    await f.worker.shutdown();
  });
  it.each([{ callback: false, code: "COMPUTER_USER_CONTROLLED" }, { callback: true, code: "COMPUTER_USER_CONTROLLED" }, { callback: false, code: "HOST_COMPUTER_PERMISSION" }, { callback: true, code: "HOST_COMPUTER_PERMISSION" }])("stops on computer ownership/permission without retrying or taking control (%j)", async ({ callback, code }) => {
    let rounds = 0;
    const respond = vi.fn<(content: string) => Promise<void>>(async () => {});
    const provider: ModelProvider = { async *run() {
      rounds += 1;
      yield { type: "started", requestId: `human-control-${rounds}` };
      for (let index = 0; index < (callback ? 18 : 1); index += 1) {
        yield { type: "project-tool", toolCallId: `human-control-${rounds}-${index}`, providerToolName: "product_execute",
          tool: call("computer.screenshot", { expectedEpoch: 7 }), ...(callback ? { respond } : {}) };
      }
      yield { type: "completed", finishReason: "tool_calls" };
    }, testConnection: async () => {} };
    const f = fixture(provider), bot = f.repository.createBot();
    const screenshot = vi.fn(async () => { throw new AevorenBotError(code as "COMPUTER_USER_CONTROLLED" | "HOST_COMPUTER_PERMISSION"); });
    const returnControl = vi.fn();
    f.dependencies.browserService = { computerScreenshot: screenshot, returnControl } as unknown as BrowserService;
    const sent = f.worker.send({ sessionId: bot.session.id, clientNonce: crypto.randomUUID(), text: "只允许你使用电脑抓取" });
    await expect.poll(() => f.repository.getRuntimeRun(sent.runId).state).toBe("failed");
    expect(f.repository.getRuntimeRun(sent.runId).lastErrorCode).toBe(code);
    expect(rounds).toBe(1);
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(returnControl).not.toHaveBeenCalled();
    expect(f.repository.listToolInvocations(bot.session.id)).toMatchObject([{ state: "failed", lastErrorCode: code }]);
    expect(f.repository.listToolInvocations(bot.session.id)).toHaveLength(1);
    if (callback) {
      expect(respond).toHaveBeenCalledTimes(1);
      expect(JSON.parse(respond.mock.calls[0]![0])).toMatchObject({ ok: false, code, safeMessage: expect.stringContaining("交给 AI") });
    }
    await f.worker.shutdown();
  });
  it("stops at an explicit return-control waiting_user result without treating it as a completed return", async () => {
    let rounds = 0;
    const provider: ModelProvider = { async *run() {
      rounds += 1;
      yield { type: "started", requestId: `return-control-${rounds}` };
      yield { type: "project-tool", toolCallId: `return-control-${rounds}`, providerToolName: "product_execute", tool: call("computer.returnControl", { expectedEpoch: 7 }) };
      yield { type: "completed", finishReason: "tool_calls" };
    }, testConnection: async () => {} };
    const f = fixture(provider), bot = f.repository.createBot();
    const returnControl = vi.fn();
    f.dependencies.browserService = { returnControl } as unknown as BrowserService;
    const sent = f.worker.send({ sessionId: bot.session.id, clientNonce: crypto.randomUUID(), text: "请把电脑交给 AI 后继续" });
    await expect.poll(() => f.repository.getRuntimeRun(sent.runId).state).toBe("failed");
    expect(f.repository.getRuntimeRun(sent.runId).lastErrorCode).toBe("COMPUTER_USER_CONTROLLED");
    expect(rounds).toBe(1);
    expect(returnControl).not.toHaveBeenCalled();
    expect(f.repository.listToolInvocations(bot.session.id)).toMatchObject([{ state: "succeeded", resultMetadata: { status: "waiting_user" } }]);
    expect(f.repository.listToolInvocations(bot.session.id)).toHaveLength(1);
    await f.worker.shutdown();
  });
  it("persists delegated identity and sends only the delegated task to the recipient model", async () => {
    let prompt = "";
    const provider: ModelProvider = { async *run(messages) { prompt = JSON.stringify(messages); yield { type: "started", requestId: "recipient" }; yield { type: "delta", text: "实际回复：脚本已起草" }; yield { type: "completed", finishReason: "stop" }; }, testConnection: async () => {} };
    const f = fixture(provider);
    const recipient = f.repository.createBot();
    const old = crypto.randomUUID();
    f.repository.prepareMessage({ sessionId: recipient.session.id, clientNonce: old, text: "PRIVATE_HISTORY_DO_NOT_SHARE" });
    f.repository.createMemory(recipient.bot.id, "PRIVATE_MEMORY_DO_NOT_SHARE");
    const output = JSON.parse((await f.execute(call("messages.send", { sessionId: recipient.session.id, text: "请起草自媒体脚本" }))).content);
    await expect.poll(() => f.repository.getRuntimeRun(output.result.runId).state).toBe("completed");
    const input = f.repository.getUserMessage(output.result.clientNonce);
    expect(input.origin).toMatchObject({ kind: "ai-delegation", fromBotId: f.actor.bot.id, depth: 1 });
    expect(prompt).toContain("AI_DELEGATED_TASK");
    expect(prompt).not.toContain("PRIVATE_HISTORY_DO_NOT_SHARE");
    expect(prompt).not.toContain("PRIVATE_MEMORY_DO_NOT_SHARE");
    expect(f.repository.getRuntimeRun(output.result.runId).assistantEntryId).toBeTruthy();
    const receipt = JSON.parse((await f.execute(call("tasks.getResult", { runId: output.result.runId }))).content);
    expect(receipt.result.response.body).toContain("实际回复");
    const other = f.repository.createBot();
    const another = f.worker.send({ sessionId: other.session.id, clientNonce: crypto.randomUUID(), text: "private task" });
    expect(() => f.service.validate(call("tasks.getResult", { runId: another.runId }), f.runtime.id)).toThrow();
    await f.worker.shutdown();
  });

  it.each(["library.read", "documents.read", "skills.read", "skills.load", "skills.readFile"])("pins implicit %s to this message's selected revision and permits an explicit other version", async (operation) => {
    const f = fixture();
    const first = f.libraryService.create({ sessionId: f.actor.session.id, kind: operation.startsWith("documents.") ? "document" : "skill", name: "Pinned resource", body: "PINNED_V1" });
    f.repository.transitionRuntimeRun(f.runtime.id, "completed");
    const runtime = libraryRuntime(f.repository, f.actor, [first.reference]);
    const second = f.libraryService.update({ sessionId: f.actor.session.id, id: first.resource.id, expectedVersion: 1, body: "EDITED_V2" });
    const input = { id: first.resource.id, ...(operation === "skills.readFile" ? { path: "SKILL.md" } : {}) };
    const implicit = JSON.parse((await f.execute(call(operation, input), runtime.id)).content).result;
    if (operation === "skills.readFile") expect(implicit.data).toBe("PINNED_V1");
    else expect(implicit.revision).toMatchObject({ id: first.revision.id, body: "PINNED_V1", digest: first.reference.digest });
    const explicit = JSON.parse((await f.execute(call(operation, { ...input, revisionId: second.revision.id }), runtime.id)).content).result;
    if (operation === "skills.readFile") expect(explicit.data).toBe("EDITED_V2");
    else expect(explicit.revision).toMatchObject({ id: second.revision.id, body: "EDITED_V2" });
    f.repository.library.unbind({ sessionId: f.actor.session.id, id: first.resource.id });
    await expect(f.execute(call(operation, input), runtime.id)).rejects.toMatchObject({ code: "LIBRARY_NOT_BOUND" });
  });

  it.each([
    ["unbind", "LIBRARY_NOT_BOUND"], ["disable", "LIBRARY_DISABLED"], ["delete", "LIBRARY_NOT_FOUND"],
  ])("refuses cached created document bodies after %s without creating another resource", async (change, code) => {
    const f = fixture();
    const command = call("documents.create", { name: "Receipt resource", body: "REVOKED_BODY_CANARY" });
    const created = JSON.parse((await f.execute(command)).content).result;
    const mutation = { sessionId: f.actor.session.id, id: created.resource.id, expectedVersion: created.resource.version };
    if (change === "unbind") f.repository.library.unbind({ sessionId: mutation.sessionId, id: mutation.id });
    else if (change === "disable") f.repository.library.setEnabled({ ...mutation, enabled: false });
    else f.repository.library.delete(mutation);
    await expect(f.execute(command)).rejects.toMatchObject({ code });
    expect(f.repository.library.available({ includeDisabled: true, includeDeleted: true })).toHaveLength(1);
    expect(f.repository.productResourceCount(f.runtime.clientNonce)).toBe(1);
  });

  it("refuses cached update and restored-version bodies after revocation without writing another revision", async () => {
    const f = fixture();
    const original = f.libraryService.create({ sessionId: f.actor.session.id, kind: "document", name: "Versions", body: "VERSION_ONE" });
    const update = call("documents.update", { id: original.resource.id, expectedVersion: 1, body: "VERSION_TWO" });
    const second = JSON.parse((await f.execute(update)).content).result;
    f.repository.library.unbind({ sessionId: f.actor.session.id, id: original.resource.id });
    await expect(f.execute(update)).rejects.toMatchObject({ code: "LIBRARY_NOT_BOUND" });
    f.repository.library.bind({ sessionId: f.actor.session.id, id: original.resource.id });
    expect(f.repository.library.versions({ sessionId: f.actor.session.id, id: original.resource.id })).toHaveLength(2);
    const restore = call("documents.restoreVersion", { id: original.resource.id, expectedVersion: second.resource.version, revisionId: original.revision.id });
    const restored = JSON.parse((await f.execute(restore)).content).result;
    f.repository.library.setEnabled({ sessionId: f.actor.session.id, id: original.resource.id, expectedVersion: restored.resource.version, enabled: false });
    await expect(f.execute(restore)).rejects.toMatchObject({ code: "LIBRARY_DISABLED" });
    expect(f.repository.library.versions({ sessionId: f.actor.session.id, id: original.resource.id, includeDisabled: true })).toHaveLength(3);
  });

  it("rechecks every cached import body and refuses a revoked member of the imported array", async () => {
    const f = fixture();
    const source = join(f.root, "sources");
    mkdirSync(join(source, "batch"), { recursive: true });
    writeFileSync(join(source, "batch", "one.md"), "IMPORTED_ONE");
    writeFileSync(join(source, "batch", "two.md"), "IMPORTED_TWO");
    const registration = await f.dependencies.workspaceService.registerRoot(source);
    const actor = f.repository.createBot(registration.project.id);
    const runtime = libraryRuntime(f.repository, actor);
    f.dependencies.pickLibraryPaths = async () => [join(source, "batch", "one.md"), join(source, "batch", "two.md")];
    const command = call("library.pickImport", { kind: "document" });
    const first = JSON.parse((await f.execute(command, runtime.id)).content).result;
    f.repository.library.unbind({ sessionId: actor.session.id, id: first.imported[0].resource.id });
    rmSync(source, { recursive: true });
    await expect(f.execute(command, runtime.id)).rejects.toMatchObject({ code: "LIBRARY_NOT_BOUND" });
    expect(f.repository.library.available()).toHaveLength(2);
  });

  it("exports the current message's selected version by default while accepting an explicit later version", async () => {
    const f = fixture();
    const first = f.libraryService.create({ sessionId: f.actor.session.id, kind: "document", name: "Pinned export", body: "EXPORT_V1" });
    f.repository.transitionRuntimeRun(f.runtime.id, "completed");
    const runtime = libraryRuntime(f.repository, f.actor, [first.reference]);
    const second = f.libraryService.update({ sessionId: f.actor.session.id, id: first.resource.id, expectedVersion: 1, body: "EXPORT_V2" });
    f.dependencies.exportLibraryResource = vi.fn(async (input, signal) => {
      const snapshot = await f.libraryService.prepareExport(input, signal);
      const path = await writeLibraryExport(snapshot, join(f.root, `${crypto.randomUUID()}.md`), signal,
        () => { f.repository.library.read(input, f.actor.bot.id); });
      return { path, resourceId: snapshot.resourceId, revisionId: snapshot.revisionId };
    });
    const implicit = JSON.parse((await f.execute(call("documents.export", { id: first.resource.id }), runtime.id)).content).result;
    expect(implicit.revisionId).toBe(first.revision.id);
    expect(readFileSync(implicit.path, "utf8")).toBe("EXPORT_V1");
    const explicit = JSON.parse((await f.execute(call("documents.export", { id: first.resource.id, revisionId: second.revision.id }), runtime.id)).content).result;
    expect(explicit.revisionId).toBe(second.revision.id);
    expect(readFileSync(explicit.path, "utf8")).toBe("EXPORT_V2");
  });

  it.each(["library.export", "documents.export", "skills.export"])("reports repeated %s only as a historical receipt after the actual output is deleted", async (operation) => {
    const f = fixture();
    const content = f.libraryService.create({ sessionId: f.actor.session.id, kind: operation === "skills.export" ? "skill" : "document", name: "Export receipt", body: "EXPORTED_CONTENT" });
    f.dependencies.exportLibraryResource = vi.fn(async (input, signal) => {
      const snapshot = await f.libraryService.prepareExport(input, signal);
      const path = await writeLibraryExport(snapshot, join(f.root, snapshot.kind === "skill" ? "exported-skill" : "exported.md"), signal,
        () => { f.repository.library.read(input, f.actor.bot.id); });
      return { path, resourceId: snapshot.resourceId, revisionId: snapshot.revisionId };
    });
    const command = call(operation, { id: content.resource.id });
    const first = JSON.parse((await f.execute(command)).content);
    expect(existsSync(first.result.path)).toBe(true);
    rmSync(first.result.path, { recursive: true });
    const replay = await f.execute(command);
    const output = JSON.parse(replay.content);
    expect(output).toMatchObject({ status: "previously_completed", reused: true, outputVerification: "not_rechecked", result: first.result });
    expect(replay.invocation.resultMetadata).toMatchObject({ status: "previously_completed", reused: true, outputVerification: "not_rechecked" });
    expect(f.dependencies.exportLibraryResource).toHaveBeenCalledTimes(1);
    expect(existsSync(output.result.path)).toBe(false);
  });

  it("keeps a cancelled export cancelled when its receipt is reused", async () => {
    const f = fixture();
    const content = f.libraryService.create({ sessionId: f.actor.session.id, kind: "document", name: "Cancelled export", body: "content" });
    f.dependencies.exportLibraryResource = vi.fn(async () => null);
    const command = call("documents.export", { id: content.resource.id });
    expect(JSON.parse((await f.execute(command)).content).status).toBe("cancelled");
    expect(JSON.parse((await f.execute(command)).content)).toMatchObject({ status: "cancelled", reused: true, result: null });
    expect(f.dependencies.exportLibraryResource).toHaveBeenCalledTimes(1);
  });

  it("marks cached binding metadata as a prior receipt without silently granting access again", async () => {
    const f = fixture();
    const content = f.libraryService.create({ sessionId: f.actor.session.id, kind: "document", name: "Binding receipt", body: "body" });
    const command = call("library.bind", { id: content.resource.id });
    const first = JSON.parse((await f.execute(command)).content);
    f.repository.library.unbind({ sessionId: f.actor.session.id, id: content.resource.id });
    const replay = JSON.parse((await f.execute(command)).content);
    expect(replay).toMatchObject({ reused: true, result: first.result });
    expect(replay.receiptNotice).toContain("首次操作回执");
    expect(() => f.repository.library.read({ sessionId: f.actor.session.id, id: content.resource.id })).toThrow(/未授权/);
  });
});


describe("demonstration product approvals", () => {
  it("requires genuine approval and publishes a fixed saved draft once, initially disabled", async () => {
    const f = fixture();
    f.dependencies.demonstrationService = new DemonstrationService(f.repository, { demonstrationRequest: async () => null }, f.libraryService);
    const now = new Date().toISOString(), scope = { sessionId: f.actor.session.id, executorBotId: f.actor.bot.id };
    const draft = f.repository.demonstrations.create(scope, { id: crypto.randomUUID(), browserSessionId: crypto.randomUUID(), epoch: 2, state: "stopped", reason: null, events: [{ kind: "redacted-text" }], eventCount: 1, createdAt: now, updatedAt: now });
    const tool = call("demonstrations.publish", { id: draft.id, expectedVersion: 1, expectedDigest: draft.digest });
    expect(f.service.requiresApproval(tool)).toBe(true); expect(f.service.requiresApproval(call("demonstrations.readDraft", { id: draft.id }))).toBe(false);
    const pending = f.prepare(tool);
    expect(await f.service.handlers.get("approvals:review")!({ ...scope, id: pending.approval.id, expectedVersion: pending.approval.version })).toMatchObject({ executable: true, snapshot: { kind: "demonstration-skill", resourceName: draft.name, target: { body: draft.body, draftDigest: draft.digest, initiallyEnabled: false } } });
    await expect(f.executor.execute(pending.invocation.id)).rejects.toMatchObject({ code: "TOOL_STATE_INVALID" }); expect(f.repository.library.list({ sessionId: scope.sessionId, includeDisabled: true })).toHaveLength(0);
    f.repository.resolveToolApproval(pending.approval.id, pending.approval.version, "allow-once"); const receipt = JSON.parse((await f.executor.execute(pending.invocation.id)).content); expect(receipt.result.resource.enabled).toBe(false); expect(receipt.result.revision.body).toBe(draft.body);
    const replay = JSON.parse((await f.execute(tool)).content); expect(replay.status).toBe("previously_completed"); expect(replay.result.resource.id).toBe(receipt.result.resource.id); expect(f.repository.library.list({ sessionId: scope.sessionId, includeDisabled: true })).toHaveLength(1);
    const request = await f.execute(call("demonstrations.start", { id: crypto.randomUUID(), expectedEpoch: 2 })); expect(JSON.parse(request.content).status).toBe("waiting_user");
  });
  it("a saved draft edit after approval invalidates the old digest without publishing", async () => {
    const f = fixture(); f.dependencies.demonstrationService = new DemonstrationService(f.repository, { demonstrationRequest: async () => null }, f.libraryService);
    const scope = { sessionId: f.actor.session.id, executorBotId: f.actor.bot.id }, now = new Date().toISOString(); const draft = f.repository.demonstrations.create(scope, { id: crypto.randomUUID(), browserSessionId: crypto.randomUUID(), epoch: 2, state: "stopped", reason: null, events: [], eventCount: 0, createdAt: now, updatedAt: now });
    const pending = f.prepare(call("demonstrations.publish", { id: draft.id, expectedVersion: 1, expectedDigest: draft.digest })); f.repository.resolveToolApproval(pending.approval.id, pending.approval.version, "allow-once");
    f.repository.demonstrations.update({ ...scope, id: draft.id, expectedVersion: 1, name: "Changed draft", body: draft.body + "\nCHANGED_AFTER_APPROVAL" });
    await expect(f.executor.execute(pending.invocation.id)).rejects.toMatchObject({ code: "DEMONSTRATION_VERSION_CONFLICT" }); expect(f.repository.library.list({ sessionId: scope.sessionId, includeDisabled: true })).toHaveLength(0);
  });
  it.each(["unbind", "delete"] as const)("rechecks the original published Skill before a cached receipt after %s", async change => {
    const f = fixture(); f.dependencies.demonstrationService = new DemonstrationService(f.repository, { demonstrationRequest: async () => null }, f.libraryService);
    const scope = { sessionId: f.actor.session.id, executorBotId: f.actor.bot.id }, now = new Date().toISOString();
    const draft = f.repository.demonstrations.create(scope, { id: crypto.randomUUID(), browserSessionId: crypto.randomUUID(), epoch: 2, state: "stopped", reason: null, events: [], eventCount: 0, createdAt: now, updatedAt: now });
    const tool = call("demonstrations.publish", { id: draft.id, expectedVersion: draft.version, expectedDigest: draft.digest });
    const first = JSON.parse((await f.execute(tool)).content).result as import("@shared/library-contracts").LibraryContent;
    const edited = f.repository.library.update({ sessionId: scope.sessionId, id: first.resource.id, expectedVersion: first.resource.version, body: draft.body + "\nLATER_LIBRARY_EDIT" });
    const replay = JSON.parse((await f.execute(tool)).content).result as import("@shared/library-contracts").LibraryContent;
    expect(replay.revision.id).toBe(first.revision.id); expect(replay.revision.body).toBe(draft.body); expect(replay.resource.enabled).toBe(false);
    if (change === "unbind") f.repository.library.unbind({ sessionId: scope.sessionId, id: first.resource.id });
    else f.repository.library.delete({ sessionId: scope.sessionId, id: first.resource.id, expectedVersion: edited.resource.version });
    await expect(f.execute(tool)).rejects.toBeDefined();
    const saved = f.repository.demonstrations.read(scope, draft.id); expect(saved.publishedResourceId).toBe(first.resource.id);
    const resources = f.repository.library.available({ includeDeleted: true, includeDisabled: true });
    expect(resources).toHaveLength(1); expect(resources[0]?.enabled).toBe(false);
  });
});

it("returns the same safe computer health diagnostic through the AI product gateway", async () => {
  const f = fixture(), diagnostic = { attemptId: crypto.randomUUID(), phase: "error" as const, blocker: "startup-failed" as const,
    message: "Computer engine stopped", errorCode: "COMPUTER_DESKTOP_UNAVAILABLE", checkedAt: new Date().toISOString(), bootId: crypto.randomUUID() };
  f.dependencies.browserService = { get: vi.fn(async () => ({ state: "error" })), startupStatus: vi.fn(() => diagnostic) } as unknown as BrowserService;
  const result = await f.execute({ kind: "product-call", action: "execute", operation: "browser.get" });
  expect(JSON.parse(result.content).result).toMatchObject({ state: "error", startup: diagnostic });
  expect(result.content).not.toMatch(/encryptedToken|Bearer|workerPort/u);
});
