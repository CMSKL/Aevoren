import { app, Menu } from "electron";
import { join } from "node:path";

if (process.env.AEVOREN_BOT_USE_SYSTEM_SAFE_STORAGE === "1") {
  app.commandLine.removeSwitch("use-mock-keychain");
}
// Electron 44 initializes safeStorage's Keychain/Linux namespace before ready.
// Retain the established identity until then so existing credentials still decrypt.
app.setName("Aevoren Bot");
app.setPath("userData", join(app.getPath("appData"), "Aevoren Bot"));
app.once("ready", () => {
  app.setName("Aevoren");
  app.setAboutPanelOptions({ applicationName: "Aevoren" });
  // The default macOS app menu was built using the bootstrap name.
  if (process.platform === "darwin") {
    const menu = Menu.getApplicationMenu();
    if (menu) Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, ...menu.items.slice(1)]));
  }
});
