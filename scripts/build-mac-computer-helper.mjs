import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
if (process.platform === "darwin") {
  mkdirSync("out/native-mac", { recursive: true });
  // Development can use Intel Node while the release app targets arm64.
  const directory = mkdtempSync("out/native-mac/build-");
  try {
    const binaries = ["arm64", "x86_64"].map(arch => {
      const binary = join(directory, arch);
      execFileSync("/usr/bin/swiftc", ["-swift-version", "5", "-O", "-target", `${arch}-apple-macosx13.0`, "src/native-mac/computer-input.swift", "-o", binary], { stdio: "inherit" });
      return binary;
    });
    execFileSync("/usr/bin/lipo", ["-create", ...binaries, "-output", "out/native-mac/computer-input"], { stdio: "inherit" });
    execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", "out/native-mac/computer-input"], { stdio: "inherit" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
