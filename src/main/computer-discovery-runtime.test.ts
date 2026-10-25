import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { AppRepository } from "./database";
import { parseStructuredModelToolCall, type ModelProvider, type ModelRunContext } from "./model";
import { RuntimeExecutor } from "./runtime-executor";
import { BROWSER_OPERATION_SCHEMAS } from "@shared/browser-product";

async function contextFor(text: string, purpose?: "work" | "coordinate" | "summary", scoped = false): Promise<ModelRunContext | undefined> {
  const repository = new AppRepository(":memory:");
  const { bot, session } = repository.createBot();
  const clientNonce = randomUUID();
  const room = purpose ? repository.createRoom({ name: "电脑发现群", memberBotIds: [bot.id, repository.createBot().bot.id], leadBotId: null }) : null;
  const sessionId = room?.session.id ?? session.id;
  if (room) repository.prepareRoomMessage({ sessionId, roomId: room.room.id, clientNonce, text, targetBotIds: [bot.id] });
  else repository.prepareMessage({ sessionId, clientNonce, text });
  repository.acknowledgeUserMessage(clientNonce);
  let actual: ModelRunContext | undefined;
  const provider: ModelProvider = {
    async *run(_messages, _signal, context) {
      actual ??= context;
      yield { type: "started", requestId: "discovery-contract" };
      yield { type: "delta", text: "收到。" };
      yield { type: "completed", finishReason: "stop" };
    },
    async testConnection() {},
  };
  const runtime = new RuntimeExecutor(repository, null, { transcript() {}, runtime() {} }, false, provider);
  try {
    await runtime.start({ clientNonce, executorBotId: bot.id, executionKey: bot.id, ...(scoped ? { incomingHandoff: { id: randomUUID(), fromAgentId: randomUUID(), task: text, contextRefs: [], visibility: "room" as const, createdAt: new Date().toISOString() } } : {}), ...(room ? { room: { id: room.room.id, membershipVersion: room.room.membershipVersion, sourceTurnId: randomUUID(), orchestrationEnabled: false, turnPurpose: purpose } } : {}) }).completion;
    expect(repository.listToolInvocations(sessionId)).toEqual([]);
    return actual;
  } finally {
    await runtime.shutdown();
    repository.close();
  }
}

it.each([
  ["只允许你使用电脑抓取", true],
  ["只用电脑抓取 https://example.com", true],
  ["你用你的电脑打开百度。", true],
  ["我说你用你的内置电脑", true],
  ["请用隔离浏览器访问测试页", true],
  ["Use your computer to open the test page", true],
  ["请用你自己的电脑打开测试页", true],
  ["你可以用你的电脑打开这个网页吗？", true],
  ["你有内置电脑吗？", false],
  ["你能使用你的内置电脑吗？", false],
  ["Can you use your computer?", false],
  ["怎么配置内置电脑？", false],
  ["不要用你的电脑打开网页", false],
  ["请不要使用内置电脑", false],
  ["请用我的 Mac 打开网页", false],
  ["请控制宿主机电脑", false],
])("discovers scoped computer tools only for an execution request: %s", async (text, required) => {
  const actual = await contextFor(text);
  expect(actual?.projectTools).toBe(true);
  expect(actual?.requiredToolNames?.includes("product_catalog")).toBe(required);
  expect(actual?.requiredToolNames).not.toContain("product_execute");
});

it.each(["work", "coordinate", "summary"] as const)("limits discovery to group work, never %s coordination", async purpose => {
  const actual = await contextFor("请用你的内置电脑打开 http://example.com", purpose);
  expect(actual?.projectTools).toBe(purpose === "work");
  expect(actual?.requiredToolNames?.includes("product_catalog")).toBe(purpose === "work");
  expect(actual?.requiredToolNames).not.toContain("web_fetch");
});

it.each(["只允许你使用电脑抓取", "只用电脑抓取 https://example.com"])("does not force a public fetch for a computer-only request: %s", async text => {
  const actual = await contextFor(text);
  expect(actual?.requiredToolNames).toContain("product_catalog");
  expect(actual?.requiredToolNames).not.toContain("web_fetch");
});

it("retains a separately requested public fetch alongside computer discovery", async () => {
  const actual = await contextFor("请用你的内置电脑打开测试页，并调用 web_fetch 抓取 https://example.com");
  expect(actual?.requiredToolNames).toEqual(expect.arrayContaining(["product_catalog", "web_fetch"]));
});

it.each([{ epoch: 1, valid: true }, { epoch: "1", valid: false }, { epoch: 0, valid: false }])("keeps native epoch validation strict: $epoch", ({ epoch, valid }) => {
  const event = parseStructuredModelToolCall("computer-schema", "product_execute", { operation: "computer.screenshot", input: { expectedEpoch: epoch } }, { executorBotId: randomUUID(), executionKey: "schema", projectTools: true });
  if (event.type !== "project-tool" || event.tool.kind !== "product-call" || event.tool.action !== "execute") throw new Error("Expected product execution");
  expect(event.tool.input).toEqual({ expectedEpoch: epoch });
  expect(BROWSER_OPERATION_SCHEMAS["computer.screenshot"]!.safeParse(event.tool.input).success).toBe(valid);
});

// Original read-only diagnostic plus positive contrasts and conditional requirements.
it.each([
  {
    "request": "阶段一 P4 只读诊断：只查询你当前已有的内置浏览器状态，并用 browser.observe 读取先前页面。不得启动或重启、导航、输入、截图、接管、外发或文件写入；不要通过 execution 绕过。若当前归用户控制，只报告该状态并停止。",
    "mustExclude": [
      "workspace_write",
      "text_measure"
    ]
  },
  {
    "request": "请读取 brief.md；不得安装、启动或文件写入。",
    "mustInclude": [
      "workspace_read"
    ],
    "mustExclude": [
      "workspace_write"
    ]
  },
  {
    "request": "Please read brief.md. Do not restart, navigate, type, screenshot, or write files.",
    "mustInclude": [
      "workspace_read"
    ],
    "mustExclude": [
      "workspace_write"
    ]
  },
  {
    "request": "不要联网，但请保存为 result.md",
    "mustInclude": [
      "workspace_write"
    ],
    "mustExclude": [
      "web_fetch",
      "web_search"
    ]
  },
  {
    "request": "不要读取 brief.md，也不要写入 result.md",
    "mustExclude": [
      "workspace_read",
      "workspace_write"
    ]
  },
  {
    "request": "不得安装、重启、写入 CSV 或保存 Markdown。",
    "mustExclude": [
      "workspace_write"
    ]
  },
  {
    "request": "不得启动、导航、输入、截图或计算字数。",
    "mustExclude": [
      "text_measure",
      "workspace_write"
    ]
  },
  {
    "request": "Do not restart, navigate, read files, or write a report.",
    "mustExclude": [
      "workspace_read",
      "workspace_write"
    ]
  },
  {
    "request": "不要只读取，还要保存 result.md。",
    "mustInclude": [
      "workspace_write"
    ]
  },
  {
    "request": "不是不要保存；请保存 result.md。",
    "mustInclude": [
      "workspace_write"
    ]
  },
  {
    "request": "不是不要保存文件。",
    "mustExclude": [
      "workspace_write"
    ]
  },
  {
    "request": "如果用户接管，就只报告并停止；不得读取、截图、输入或文件写入。",
    "mustExclude": [
      "workspace_write",
      "workspace_read"
    ]
  },
  {
    "request": "请必须写入 result.md 并回读确认。",
    "mustInclude": [
      "workspace_write"
    ]
  },
  {
    "request": "Do not navigate or read files, but please write report.md.",
    "mustInclude": [
      "workspace_write"
    ],
    "mustExclude": [
      "workspace_read",
      "web_fetch"
    ]
  }
])("extracts actionable supported requirements and excludes retired directory tools: $request", async ({ request, mustInclude, mustExclude }) => {
  for (const purpose of [undefined, "work"] as const) {
    const actual = await contextFor(request, purpose, purpose === "work");
    for (const name of mustInclude ?? []) {
      if (name.startsWith("workspace_")) expect(actual?.requiredToolNames).not.toContain(name);
      else expect(actual?.requiredToolNames).toContain(name);
    }
    for (const name of mustExclude ?? []) expect(actual?.requiredToolNames).not.toContain(name);
  }
});

it.each([
  ["这些长度只引用读取返回的 fullLength，不重新计算文本。", false],
  ["Only quote the returned fullLength character count; do not recalculate text.", false],
  ["引用 fullLength，并用 text_measure 统计正文非空白字符数。", true],
  ["请计算这段正文的长度。", true],
  ["不得启动、输入或计算字数。", false],
  ["只查询状态，不使用 text_measure。", false],
  ["如果电脑成功启动，再保存 result.md。", false],
])("distinguishes quoted lengths and unmet conditions: %s", async (request, measure) => {
  const actual = await contextFor(request as string);
  expect(actual?.requiredToolNames?.includes("text_measure")).toBe(measure);
  if (request.startsWith("如果")) expect(actual?.requestedWritePaths).toEqual([]);
});
