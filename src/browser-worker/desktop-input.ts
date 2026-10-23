import { setTimeout as delay } from "node:timers/promises";
import { BrowserWorkerError } from "./worker-error";

type Program = (args: string[], text?: string) => Promise<unknown>;
export class DesktopInput {
  private readonly held = new Set<string>();
  private readonly keys = new Set<string>();
  constructor(private readonly run: Program) {}

  async release(): Promise<void> {
    const buttons = [...this.held], keys = [...this.keys];
    this.held.clear(); this.keys.clear();
    await Promise.all([...buttons.map(button => this.run(["mouseup", button])), ...keys.map(key => this.run(["keyup", key]))]);
  }

  async perform(input: Record<string, unknown>, check: () => void, run: Program = this.run): Promise<void> {
    const button = { left: "1", middle: "2", right: "3" }[String(input.button ?? "left") as "left" | "middle" | "right"];
    const point = (x: unknown, y: unknown): string[] => {
      if (!Number.isInteger(x) || !Number.isInteger(y) || Number(x) < 0 || Number(y) < 0 || Number(x) >= 1_280 || Number(y) >= 800) throw new BrowserWorkerError("BROWSER_COORDINATE_INVALID");
      return ["mousemove", String(x), String(y)];
    };
    const step = async (args: string[], text?: string): Promise<void> => { check(); await run(args, text); check(); };
    check();
    if (input.method === "drag") {
      const path = input.path as Array<{ x: number; y: number }>;
      for (const position of path) point(position.x, position.y);
      try {
        await step(point(path[0]!.x, path[0]!.y));
        this.held.add(button);
        await step(["mousedown", button]);
        for (const position of path.slice(1)) { await delay(16); await step(point(position.x, position.y)); }
      } finally { await this.release(); }
    } else if (input.method === "click") {
      try {
        await step(point(input.x, input.y));
        this.held.add(button); await step(["mousedown", button]);
      } finally { await this.release(); }
    } else if (input.method === "move") await step(point(input.x, input.y));
    else if (input.method === "mouseDown") { this.held.add(button); await step(["mousedown", button]); }
    else if (input.method === "mouseUp") { await step(["mouseup", button]); this.held.delete(button); }
    else if (input.method === "type") await step(["type", "--clearmodifiers", "--delay", "0", "--file", "-"], String(input.text));
    else if (input.method === "key") {
      const key = String(input.key).replaceAll("Control", "ctrl").replaceAll("Meta", "super").replaceAll("Arrow", "");
      for (const part of key.split("+")) this.keys.add(part);
      try { await step(["key", "--clearmodifiers", key]); } finally { await this.release(); }
    }
    else if (input.method === "scroll") {
      if (input.x !== undefined && input.y !== undefined) await step(point(input.x, input.y));
      for (const [delta, positive, negative] of [[Number(input.deltaY), "5", "4"], [Number(input.deltaX), "7", "6"]] as const) {
        if (delta) await step(["click", "--repeat", String(Math.min(100, Math.ceil(Math.abs(delta) / 100))), "--delay", "0", delta > 0 ? positive : negative]);
      }
    } else throw new BrowserWorkerError("BROWSER_INVALID_REQUEST");
  }
}
