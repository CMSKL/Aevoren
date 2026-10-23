import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { AevorenBotError } from "./errors";
import { DockerDriver } from "./docker-driver";

async function launch(program: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { shell: false, detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject); child.once("spawn", () => { child.unref(); resolve(); });
  });
}

/** Human-requested runtime launch. Engine readiness is checked separately by the existing probe. */
export async function openLocalDocker(): Promise<void> {
  const driver = new DockerDriver(), probe = await driver.probe();
  if (probe.status === "ready") return;
  if (probe.status === "unsupported" || probe.status === "error") throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE", probe.reason ?? "当前本机 Docker 环境不可用。");
  if (process.platform === "darwin") {
    const colimaPath = ["/opt/homebrew/bin/colima", "/usr/local/bin/colima"].find(path => existsSync(path));
    if (probe.status === "missing" && colimaPath) throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE", "已找到 Colima，请先安装 Docker CLI 后重试。");
    if (probe.status !== "missing") {
      const context = await driver.localContext();
      const colima = /^colima(?:-([a-zA-Z0-9][a-zA-Z0-9_-]{0,62}))?$/u.exec(context);
      if (colima) {
        if (!colimaPath) throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE", "当前 context 使用 Colima，但未找到 Colima 命令，请先恢复 Colima 安装。");
        await launch(colimaPath, ["start", "--profile", colima[1] ?? "default", "--activate=false"]); return;
      }
      if (!["default", "desktop-linux"].includes(context) || !existsSync("/Applications/Docker.app")) {
        throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE", "请先启动当前 Docker context 对应的本机引擎，再点击重试；无需安装 Docker Desktop。");
      }
    }
  }
  if (process.platform === "darwin" && existsSync("/Applications/Docker.app")) {
    await promisify(execFile)("/usr/bin/open", ["-g", "-a", "/Applications/Docker.app"]); return;
  }
  const windowsPath = join(process.env.ProgramFiles ?? "C:\\Program Files", "Docker", "Docker", "Docker Desktop.exe");
  if (process.platform === "win32" && existsSync(windowsPath)) {
    await launch(windowsPath, []); return;
  }
  if (process.platform === "darwin" || process.platform === "win32") {
    const { shell } = await import("electron");
    await shell.openExternal("https://www.docker.com/products/docker-desktop/"); return;
  }
  throw new AevorenBotError("ENVIRONMENT_UNAVAILABLE", "请先启动本机 Docker Linux 服务后重试。");
}
