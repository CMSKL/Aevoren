import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { test, type ElectronApplication, type Locator } from "@playwright/test";

/** Capture a real hidden Electron frame without CDP's Windows screenshot wait. */
export async function captureElectron(application: ElectronApplication, path: string, locator?: Locator): Promise<void> {
  const bounds = locator ? await locator.boundingBox() : undefined;
  if (locator && !bounds) throw new Error("Screenshot target is not visible");
  const result = await application.evaluate(async ({ BrowserWindow }, bounds) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Missing fixture window");
    await window.webContents.executeJavaScript("Promise.all([document.fonts.ready, ...Array.from(document.images, image => image.decode())])");
    const rect = bounds ? { x: Math.floor(bounds.x), y: Math.floor(bounds.y), width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) } : undefined;
    await window.webContents.capturePage(rect, { stayHidden: true, stayAwake: true });
    const image = await window.webContents.capturePage(rect, { stayHidden: true, stayAwake: true });
    if (image.isEmpty()) throw new Error("Native screenshot is empty");
    const bitmap = image.toBitmap();
    let visible = false, varied = false;
    for (let offset = 0; offset < bitmap.length; offset += 4) {
      visible ||= bitmap[offset + 3]! > 0;
      varied ||= bitmap[offset] !== bitmap[0] || bitmap[offset + 1] !== bitmap[1] || bitmap[offset + 2] !== bitmap[2];
      if (visible && varied) break;
    }
    return { png: image.toPNG().toString("base64"), visible, varied };
  }, bounds);
  if (!result.visible || !result.varied) throw new Error("Native screenshot has no painted content");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(result.png, "base64"));
  await test.info().attach(basename(path), { path, contentType: "image/png" });
}
