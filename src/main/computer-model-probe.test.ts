import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, inflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatibleProvider, type ChatMessage, type ModelEvent, type ModelProvider } from "./model";
import { authorizedModelImages, imageAwareChatMessages, type ModelImageAttachment } from "./model-image";
import { verifyComputerModel } from "./computer-model-probe";
import { CodexCliProvider } from "./providers/codex-cli";
import { ClaudeCliProvider } from "./providers/claude-cli";
import * as cliUtils from "./providers/cli-utils";

const shuffle = vi.hoisted(() => ({ values: [] as number[] }));
vi.mock("node:crypto", async importOriginal => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, randomInt: (maximum: number): number => {
    const value = shuffle.values.shift();
    if (value === undefined) return original.randomInt(maximum);
    if (value < 0 || value >= maximum) throw new Error("Invalid controlled shuffle");
    return value;
  } };
});
const directories: string[] = [];
afterEach(async () => {
  shuffle.values = []; vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const context = () => ({ executorBotId: randomUUID(), executionKey: randomUUID() });
const signal = () => new AbortController().signal;
const event = (answer: string, respond?: Extract<ModelEvent, { type: "project-tool" }>["respond"]): ModelEvent => ({
  type: "project-tool", toolCallId: randomUUID(),
  tool: { kind: "product-call", action: "execute", operation: "computer.verify", input: { answer } }, respond,
});
const screenshot = (respond?: Extract<ModelEvent, { type: "project-tool" }>["respond"]): ModelEvent => ({
  type: "project-tool", toolCallId: randomUUID(), tool: { kind: "product-call", action: "execute", operation: "computer.screenshot", input: {} }, respond,
});
const provider = (run: ModelProvider["run"]): ModelProvider => ({ run, testConnection: async () => {} });

/** Decode transmitted PNG data, including chunk CRCs; never derive the answer from prompt text. */
function readPanels(dataBase64: string): string {
  const bytes = Buffer.from(dataBase64, "base64");
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const compressed: Buffer[] = [];
  let width = 0, height = 0, ended = false;
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset), type = bytes.toString("ascii", offset + 4, offset + 8);
    const end = offset + 8 + length;
    expect(end + 4).toBeLessThanOrEqual(bytes.length);
    expect(bytes.readUInt32BE(end)).toBe(crc32(bytes.subarray(offset + 4, end)));
    if (type === "IHDR") {
      width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12);
      expect([...bytes.subarray(offset + 16, end)]).toEqual([8, 2, 0, 0, 0]);
    } else if (type === "IDAT") compressed.push(bytes.subarray(offset + 8, end));
    else if (type === "IEND") { ended = true; expect(length).toBe(0); expect(end + 4).toBe(bytes.length); }
    offset = end + 4;
  }
  expect(ended).toBe(true); expect(width % 3).toBe(0); expect(width).toBeGreaterThanOrEqual(3); expect(height).toBeGreaterThan(0);
  const pixels = inflateSync(Buffer.concat(compressed)), stride = width * 3 + 1;
  expect(pixels.length).toBe(stride * height);
  const names = ["red", "green", "blue"];
  const panels = Array.from({ length: 3 }, (_, panel) => {
    const namesInPanel = new Set<string>();
    for (const y of [0, Math.floor(height / 2), height - 1]) {
      expect(pixels[y * stride]).toBe(0);
      for (const x of [panel * width / 3, Math.floor((panel + 0.5) * width / 3), (panel + 1) * width / 3 - 1]) {
        const rgb = [...pixels.subarray(y * stride + 1 + x * 3, y * stride + 4 + x * 3)];
        const maximum = Math.max(...rgb), dominant = rgb.indexOf(maximum);
        expect(maximum - Math.max(...rgb.filter((_, index) => index !== dominant))).toBeGreaterThan(80);
        namesInPanel.add(names[dominant]!);
      }
    }
    expect(namesInPanel.size).toBe(1);
    return [...namesInPanel][0]!;
  });
  expect(new Set(panels).size).toBe(3);
  return panels.join(",");
}

function attachment(messages: ChatMessage[]): ModelImageAttachment {
  const images = messages.flatMap(message => message.role === "tool" ? message.images ?? [] : []);
  expect(images).toHaveLength(1);
  expect(authorizedModelImages(images)).toHaveLength(1);
  const image = images[0]!, bytes = Buffer.from(image.dataBase64, "base64");
  expect(image.reference.size).toBe(bytes.length);
  expect(image.reference.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  return image;
}
function textOnly(messages: ChatMessage[]): string {
  return JSON.stringify(messages.map(message => message.role === "tool" ? { role: message.role, content: message.content } : message));
}

function inspectImage(images?: readonly ModelImageAttachment[]): ModelImageAttachment {
  expect(images).toHaveLength(1);
  return attachment([{ role: "tool", tool_call_id: "native-frame", content: "", images: [...images!] }]);
}

// These child programs are controlled model fixtures. They use the real adapters,
// JSON-RPC/MCP transports and PNG bytes; they do not exercise a paid vision model.
const fixtureDecoder = `
import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
function inspectPng(data) {
  const bytes=Buffer.from(data,'base64'); let width=0;const compressed=[];
  for(let offset=8;offset<bytes.length;){const size=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);
    if(type==='IHDR')width=bytes.readUInt32BE(offset+8);if(type==='IDAT')compressed.push(bytes.subarray(offset+8,offset+8+size));offset+=12+size;}
  const raw=inflateSync(Buffer.concat(compressed)),names=['red','green','blue'];
  const answer=Array.from({length:3},(_,index)=>{const offset=1+Math.floor((index+0.5)*width/3)*3,rgb=[...raw.subarray(offset,offset+3)];return names[rgb.indexOf(Math.max(...rgb))]}).join(',');
  return {answer,sha256:createHash('sha256').update(bytes).digest('hex'),size:bytes.length};
}
`;

function fixtureCommand(directory: string, source: string): string {
  const script = join(directory, "controlled-computer-model.mjs");
  writeFileSync(script, `#!/usr/bin/env node\n${source}`, "utf8");
  if (process.platform !== "win32") { chmodSync(script, 0o700); return script; }
  const wrapper = join(directory, "controlled-computer-model.cmd");
  writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "%~dp0controlled-computer-model.mjs" %*\r\n`, "utf8");
  return wrapper;
}

function nativeFixture(kind: "Codex" | "Claude", directory: string): ModelProvider {
  const environment: NodeJS.ProcessEnv = { PATH: process.env.PATH, LANG: "C.UTF-8", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  vi.spyOn(cliUtils, "cliEnvironment").mockReturnValue(environment);
  vi.spyOn(cliUtils, "isolatedCodexEnvironment").mockImplementation(runtimeHome => ({ ...environment, CODEX_HOME: runtimeHome }));
  vi.spyOn(cliUtils, "readCodexConfiguredSelection").mockReturnValue(null);
  for (const name of Object.keys(process.env).filter(name => /^(?:ANTHROPIC_|CLAUDE_CODE_)/u.test(name))) vi.stubEnv(name, undefined);
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(directory, "empty-claude-config"));
  if (kind === "Codex") {
    const command = fixtureCommand(directory, `${fixtureDecoder}
import {createInterface} from 'node:readline';import {writeFileSync} from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const request=(id,operation,input)=>send({jsonrpc:'2.0',id,method:'item/tool/call',params:{threadId:'probe-thread',turnId:'probe-turn',callId:id,namespace:null,tool:'product_execute',arguments:{operation,input}}});
createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);
 if(message.method==='initialize')send({jsonrpc:'2.0',id:message.id,result:{}});
 else if(message.method==='thread/start'){writeFileSync('declared-tools.json',JSON.stringify(message.params.dynamicTools));send({jsonrpc:'2.0',id:message.id,result:{thread:{id:'probe-thread'}}})}
 else if(message.method==='turn/start'){send({jsonrpc:'2.0',id:message.id,result:{turn:{id:'probe-turn'}}});request('screenshot-pixels','computer.screenshot',{})}
 else if(message.id==='screenshot-pixels'){const picture=message.result.contentItems.find(item=>item.type==='inputImage');if(!picture)throw new Error('No actual screenshot pixels');
  const receipt=inspectPng(picture.imageUrl.split(',')[1]);writeFileSync('pixel-receipt.json',JSON.stringify(receipt));request('verify-pixels','computer.verify',{answer:receipt.answer})}
 else if(message.id==='verify-pixels')send({jsonrpc:'2.0',method:'turn/completed',params:{threadId:'probe-thread',turn:{id:'probe-turn',status:'completed'}}});
 else if(message.method==='turn/interrupt')send({jsonrpc:'2.0',id:message.id,result:{}});
});`);
    return new CodexCliProvider(command, "controlled-vision", directory);
  }
  const require = createRequire(import.meta.url);
  const clientModule = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href;
  const transportModule = pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js")).href;
  const command = fixtureCommand(directory, `${fixtureDecoder}
import {readFileSync,writeFileSync} from 'node:fs';
import {Client} from ${JSON.stringify(clientModule)};
import {StreamableHTTPClientTransport} from ${JSON.stringify(transportModule)};
process.stdin.resume();await new Promise(resolve=>process.stdin.on('end',resolve));
const configuration=JSON.parse(readFileSync(process.argv[process.argv.indexOf('--mcp-config')+1],'utf8')).mcpServers.aevoren_host;
const client=new Client({name:'controlled-computer-vision',version:'1'});
await client.connect(new StreamableHTTPClientTransport(new URL(configuration.url),{requestInit:{headers:configuration.headers}}));
console.log(JSON.stringify({type:'system',subtype:'init',session_id:'controlled-claude-probe',mcp_servers:[{name:'aevoren_host',status:'connected'}]}));
const tools=await client.listTools();writeFileSync('declared-tools.json',JSON.stringify(tools.tools));
const result=await client.callTool({name:'product_execute',arguments:{operation:'computer.screenshot',input:{}}});
const picture=result.content.find(item=>item.type==='image');if(!picture)throw new Error('No actual screenshot pixels');
const receipt=inspectPng(picture.data);writeFileSync('pixel-receipt.json',JSON.stringify(receipt));
await client.callTool({name:'product_execute',arguments:{operation:'computer.verify',input:{answer:receipt.answer}}});
console.log(JSON.stringify({type:'result',subtype:'success',result:'Verified actual image'}));await client.close();`);
  return new ClaudeCliProvider(command, "controlled-vision", directory, true);
}

describe("computer model probe (controlled providers, real transmitted PNG)", () => {
  it.each([[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1]])("requires pixel-derived color semantics without leaking the answer for shuffle %j %j", async (first, second) => {
    shuffle.values = [first, second];
    const result = vi.fn(async () => {}), closed = vi.fn();
    const model = provider(async function* (messages, receivedSignal, runContext) {
      try {
        expect(messages.some(message => message.role === "tool" && message.images?.length)).toBe(false);
        expect(runContext).toMatchObject({ projectTools: true, supportedToolNames: ["product_execute"], requiredToolNames: ["product_execute"], requireToolCall: true });
        expect(receivedSignal.aborted).toBe(false);
        let answer = "";
        yield screenshot(async (_content, images) => { answer = readPanels(inspectImage(images).dataBase64); });
        expect(textOnly(messages).replaceAll(" ", "")).not.toContain(answer);
        yield event(answer, result);
      } finally { closed(); }
    });
    await expect(verifyComputerModel(model, signal(), context())).resolves.toBeUndefined();
    expect(result).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
    expect(closed).toHaveBeenCalledOnce();
  });

  it("round-trips an actual API HTTP request with valid PNG pixels and a product_execute response", async () => {
    const requests: Record<string, unknown>[] = [];
    let fixtureError: unknown;
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        requests.push(body);
        const messages = body.messages as { role: string; content: string | { type: string; image_url?: { url: string } }[] }[];
        const pictures = messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === "image_url") : []);
        expect(pictures).toHaveLength(requests.length === 1 ? 0 : 1);
        let operation = "computer.screenshot", input: Record<string, unknown> = {};
        if (requests.length > 1) {
          expect(pictures[0]!.image_url!.url).toMatch(/^data:image\/png;base64,/);
          const answer = readPanels(pictures[0]!.image_url!.url.split(",")[1]!);
          expect(JSON.stringify(messages.filter(message => typeof message.content === "string")).replaceAll(" ", "")).not.toContain(answer);
          operation = "computer.verify"; input = { answer };
        }
        expect(body.tools).toEqual([expect.objectContaining({ function: expect.objectContaining({ name: "product_execute" }) })]);
        const delta = { tool_calls: [{ index: 0, id: `actual-api-${requests.length}`, type: "function", function: { name: "product_execute", arguments: JSON.stringify({ operation, input }) } }] };
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      } catch (error) { fixtureError = error; response.writeHead(500); response.end("Controlled API assertion failed"); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("Local API fixture did not bind");
      try { await verifyComputerModel(new OpenAiCompatibleProvider(`http://127.0.0.1:${address.port}/v1`, "controlled-vision", "local-fixture-key"), signal(), context()); }
      catch (error) { throw fixtureError ?? error; }
      expect(requests).toHaveLength(2);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it.each(["Codex", "Claude"] as const)("delivers the probe pixels through the actual %s adapter and native host-tool transport", async kind => {
    const directory = mkdtempSync(join(tmpdir(), "aevoren-computer-probe-")); directories.push(directory);
    await verifyComputerModel(nativeFixture(kind, directory), signal(), context());
    const receipt = JSON.parse(readFileSync(join(directory, "pixel-receipt.json"), "utf8")) as { answer: string; sha256: string; size: number };
    expect(receipt.answer.split(",").toSorted()).toEqual(["blue", "green", "red"]);
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/u); expect(receipt.size).toBeGreaterThan(100);
    const tools = JSON.parse(readFileSync(join(directory, "declared-tools.json"), "utf8")) as { name: string }[];
    expect(tools.map(tool => tool.name)).toEqual(["product_execute"]);
  });

  it.each(["wrong answer", "wrong operation", "wrong action", "wrong product tool", "text only", "no tool"])("rejects %s", async failure => {
    const respond = vi.fn(async () => {});
    const model = provider(async function* (messages) {
      if (failure === "text only") { yield { type: "delta", text: "The colors are red green blue" }; return; }
      if (failure === "no tool") return;
      let answer = "";
      yield screenshot(async (_content, images) => { answer = readPanels(inspectImage(images).dataBase64); });
      const value = event(answer, respond);
      if (value.type !== "project-tool" || value.tool.kind !== "product-call" || value.tool.action !== "execute") throw new Error("Invalid controlled event");
      if (failure === "wrong answer") value.tool.input = { answer: answer.split(",").toReversed().join(",") };
      if (failure === "wrong operation") value.tool.operation = "computer.click";
      if (failure === "wrong action") value.tool = { kind: "product-call", action: "describe", operation: "computer.verify" };
      if (failure === "wrong product tool") value.tool = { kind: "product-call", action: "catalog" };
      expect(textOnly(messages).replaceAll(" ", "")).not.toContain(answer);
      yield value;
    });
    await expect(verifyComputerModel(model, signal(), context())).rejects.toMatchObject({ code: "COMPUTER_MODEL_UNSUPPORTED" });
    if (["wrong answer", "wrong operation"].includes(failure)) expect(respond).toHaveBeenCalledWith(JSON.stringify({ ok: false }));
  });

  it("accepts token whitespace only after reading the actual transmitted pixels", async () => {
    const respond = vi.fn(async () => {});
    const model = provider(async function* (messages) {
      let answer = "";
      yield screenshot(async (_content, images) => { answer = readPanels(inspectImage(images).dataBase64); });
      expect(textOnly(messages).replaceAll(" ", "")).not.toContain(answer);
      yield event(` ${answer.split(",").join(", ")} `, respond);
    });
    await expect(verifyComputerModel(model, signal(), context())).resolves.toBeUndefined();
    expect(respond).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
  });

  it.each(["wrong order", "extra token", "extra prose"])("still rejects %s after trimming color tokens", async failure => {
    const respond = vi.fn(async () => {});
    const model = provider(async function* (messages) {
      let answer = "";
      yield screenshot(async (_content, images) => { answer = readPanels(inspectImage(images).dataBase64); });
      expect(textOnly(messages).replaceAll(" ", "")).not.toContain(answer);
      const tokens = answer.split(",");
      if (failure === "wrong order") tokens.reverse();
      if (failure === "extra token") tokens.push("red");
      const formatted = ` ${tokens.join(", ")} `;
      yield event(failure === "extra prose" ? `The answer is ${formatted}` : formatted, respond);
    });
    await expect(verifyComputerModel(model, signal(), context())).rejects.toMatchObject({ code: "COMPUTER_MODEL_UNSUPPORTED" });
    expect(respond).toHaveBeenCalledWith(JSON.stringify({ ok: false }));
  });

  it("rejects even a correct guess until the model has received the actual screenshot", async () => {
    shuffle.values = [2, 1];
    const model = provider(async function* () { yield event("red,green,blue"); });
    await expect(verifyComputerModel(model, signal(), context())).rejects.toMatchObject({ code: "COMPUTER_MODEL_UNSUPPORTED" });
  });

  it("rejects an array instead of the exact empty screenshot input object", async () => {
    const respond = vi.fn(async () => {});
    const model = provider(async function* () {
      const value = screenshot(respond);
      if (value.type !== "project-tool" || value.tool.kind !== "product-call" || value.tool.action !== "execute") throw new Error("Invalid controlled screenshot");
      value.tool.input = [];
      yield value;
    });
    await expect(verifyComputerModel(model, signal(), context())).rejects.toMatchObject({ code: "COMPUTER_MODEL_UNSUPPORTED" });
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(JSON.stringify({ ok: false }));
  });

  it("does not acknowledge a correct answer after cancellation and revokes its image", async () => {
    const abort = new AbortController(), respond = vi.fn(async () => {});
    let captured: ModelImageAttachment | undefined;
    const model = provider(async function* () {
      let answer = "";
      yield screenshot(async (_content, images) => { captured = inspectImage(images); answer = readPanels(captured.dataBase64); });
      abort.abort(new DOMException("Probe cancelled", "AbortError"));
      yield event(answer, respond);
    });
    await expect(verifyComputerModel(model, abort.signal, context())).rejects.toMatchObject({ name: "AbortError" });
    expect(respond).not.toHaveBeenCalled(); expect(captured!.isAuthorized()).toBe(false);
    expect(JSON.stringify(imageAwareChatMessages([{ role: "tool", tool_call_id: "cancelled", content: "cancelled", images: [captured!] }]))).not.toContain(captured!.dataBase64);
  });
});
