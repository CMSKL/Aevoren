import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { BrowserEngine } from "./engine";

it("waits for native command stdout to close after its process exits", async () => {
  const engine = new BrowserEngine({ browserSessionId: randomUUID(), profileDirectory: "unused", downloadsDirectory: "unused" });
  const command = engine as unknown as { runProgram(program: string, args: string[]): Promise<Buffer> };
  // A real child inherits stdout and drains it after the launcher exits. Node's
  // exit event does not mean all output has arrived; close owns that boundary.
  // Windows needs a detached writer to survive its launcher's exit while still
  // retaining this test's inherited stdout pipe.
  const script = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify("setTimeout(()=>process.stdout.write('COMPLETE_NATIVE_OUTPUT'),100)")}],{stdio:['ignore',process.stdout,'ignore'],detached:process.platform==='win32'});child.unref();`;
  expect((await command.runProgram(process.execPath, ["-e", script])).toString()).toBe("COMPLETE_NATIVE_OUTPUT");
});
