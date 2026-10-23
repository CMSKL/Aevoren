import { createHash, randomInt, randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import type { ModelProvider, ChatMessage, ModelRunContext } from "./model";
import type { ModelImageAttachment } from "./model-image";
import { AevorenBotError } from "./errors";

function chunk(name: string, bytes: Buffer): Buffer {
  const kind = Buffer.from(name), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([kind, bytes])));
  return Buffer.concat([size, kind, bytes, crc]);
}

/** A fresh visual challenge: its answer is absent from prompts and tool metadata. */
export async function verifyComputerModel(provider: ModelProvider, signal: AbortSignal, context: Pick<ModelRunContext, "executorBotId" | "executionKey">): Promise<void> {
  const names = ["red", "green", "blue"];
  for (let index = 2; index > 0; index--) { const other = randomInt(index + 1); [names[index], names[other]] = [names[other]!, names[index]!]; }
  const colors: Record<string, number[]> = { red: [230, 30, 30], green: [20, 180, 40], blue: [30, 70, 230] };
  const pixels = Buffer.alloc((300 * 3 + 1) * 100);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 300; x++) {
    const color = colors[names[Math.floor(x / 100)]!]!;
    for (let channel = 0; channel < 3; channel++) pixels[y * 901 + 1 + x * 3 + channel] = color[channel]!;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(300); header.writeUInt32BE(100, 4); header[8] = 8; header[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
  const image: ModelImageAttachment = { reference: { id: randomUUID(), name: "visual-probe.png", mimeType: "image/png", size: png.length, sha256: createHash("sha256").update(png).digest("hex") },
    dataBase64: png.toString("base64"), isAuthorized: () => !signal.aborted };
  const messages: ChatMessage[] = [
    { role: "system", content: "This is an isolated visual and host-tool check. First call product_execute with operation computer.screenshot and empty input {} to receive the actual test image. Then read the three colored panels from left to right. Call product_execute with operation computer.verify. Set input.answer to the three lowercase color names joined by commas, in the actual order in the image. The possible names are red or green or blue. Do not guess or use another tool." },
    { role: "user", content: "Run the visual tool check now. The screenshot tool returns an isolated test image, not the user's desktop." },
  ];
  let delivered = false, calls = 0;
  for (let round = 0; round < 3; round++) {
    const pending: Array<{ id: string; operation: string; input: unknown; result: string; images?: ModelImageAttachment[] }> = [];
    for await (const event of provider.run(messages, signal, { ...context, projectTools: true, supportedToolNames: ["product_execute"], requiredToolNames: ["product_execute"], requireToolCall: true })) {
      signal.throwIfAborted();
      if (event.type !== "project-tool") continue;
      const tool = event.tool;
      if (++calls > 4 || tool.kind !== "product-call" || tool.action !== "execute") throw new AevorenBotError("COMPUTER_MODEL_UNSUPPORTED");
      if (tool.operation === "computer.screenshot" && (tool.input === undefined || typeof tool.input === "object" && tool.input !== null && !Array.isArray(tool.input) && Object.keys(tool.input).length === 0)) {
        const content = JSON.stringify({ media: image.reference, imageTransfer: "prepared_real_pixels" });
        if (event.respond) { await event.respond(content, [image]); delivered = true; }
        else pending.push({ id: event.toolCallId, operation: tool.operation, input: tool.input, result: content, images: [image] });
        continue;
      }
      const answer = (tool.input as { answer?: unknown } | undefined)?.answer;
      const tokens = typeof answer === "string" ? answer.split(",").map(value => value.trim()) : [];
      const verified = delivered && tool.operation === "computer.verify" && tokens.length === names.length && tokens.every((value, index) => value === names[index]);
      await event.respond?.(JSON.stringify({ ok: verified }));
      if (!verified) throw new AevorenBotError("COMPUTER_MODEL_UNSUPPORTED");
      return;
    }
    if (!pending.length) break;
    messages.push({ role: "assistant", content: "", tool_calls: pending.map(call => ({ id: call.id, type: "function", function: { name: "product_execute", arguments: JSON.stringify({ operation: call.operation, input: call.input }) } })) },
      ...pending.map(call => ({ role: "tool" as const, tool_call_id: call.id, content: call.result, images: call.images })));
    delivered = true;
  }
  throw new AevorenBotError("COMPUTER_MODEL_UNSUPPORTED");
}
