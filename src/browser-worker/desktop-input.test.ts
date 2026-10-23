import { describe, expect, it } from "vitest";
import { DesktopInput } from "./desktop-input";

describe("owned desktop input", () => {
  it("performs one continuous drag and releases on success", async () => {
    const events: string[][] = [];
    const driver = new DesktopInput(async args => { events.push(args); });
    await driver.perform({ method: "drag", path: [{ x: 20, y: 30 }, { x: 30, y: 40 }, { x: 200, y: 40 }] }, () => {});
    expect(events).toEqual([["mousemove", "20", "30"], ["mousedown", "1"], ["mousemove", "30", "40"], ["mousemove", "200", "40"], ["mouseup", "1"]]);
  });
  it.each(["cancelled", "control-changed"])("releases the button without further input when %s", async reason => {
    const events: string[][] = []; let cancelled = false;
    const driver = new DesktopInput(async args => { events.push(args); if (args[0] === "mousedown") cancelled = true; });
    await expect(driver.perform({ method: "drag", path: [{ x: 20, y: 30 }, { x: 200, y: 40 }] }, () => { if (cancelled) throw new Error(reason); })).rejects.toThrow(reason);
    expect(events).toEqual([["mousemove", "20", "30"], ["mousedown", "1"], ["mouseup", "1"]]);
  });
  it("rejects an out-of-screen path before pressing", async () => {
    const events: string[][] = [];
    const driver = new DesktopInput(async args => { events.push(args); });
    await expect(driver.perform({ method: "drag", path: [{ x: 20, y: 30 }, { x: 1_280, y: 40 }] }, () => {})).rejects.toMatchObject({ code: "BROWSER_COORDINATE_INVALID" });
    expect(events).toEqual([]);
  });
  it("releases every modifier after a cancelled key combination", async () => {
    const events: string[][] = []; let cancelled = false;
    const driver = new DesktopInput(async args => { events.push(args); if (args[0] === "key") cancelled = true; });
    await expect(driver.perform({ method: "key", key: "Control+Shift+a" }, () => { if (cancelled) throw new Error("cancelled"); })).rejects.toThrow("cancelled");
    expect(events).toEqual([["key", "--clearmodifiers", "ctrl+Shift+a"], ["keyup", "ctrl"], ["keyup", "Shift"], ["keyup", "a"]]);
    await driver.release(); expect(events).toHaveLength(4);
  });
});
