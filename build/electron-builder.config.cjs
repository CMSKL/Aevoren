const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { createGitHubPublishConfiguration } = require("./release-provider.cjs");

const packageJson = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));
const releaseBuild = process.env.AEVOREN_RELEASE_BUILD === "1";
const publishConfiguration = createGitHubPublishConfiguration(packageJson.version, releaseBuild);

module.exports = {
  appId: "com.cmskl.aevorenbot",
  productName: "Aevoren",
  asar: true,
  compression: "maximum",
  afterPack: "build/after-pack.cjs",
  directories: {
    output: process.env.AEVOREN_DIST_DIR || "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "!out/native-mac/**/*", "!out/worker/**/*", "!out/browser-worker/**/*", "!out/media-parser/**/*", "!**/node_modules/pdfjs-dist/**/*", "!**/node_modules/mammoth/**/*", "!**/node_modules/@zip.js/zip.js/**/*", "package.json"],
  extraResources: [
    { from: "browser-extension", to: "browser-extension" },
    { from: "resources/icon.png", to: "icon.png" },
    { from: "THIRD_PARTY_NOTICES.md", to: "THIRD_PARTY_NOTICES.md" },
    { from: "NOTICE", to: "NOTICE" },
    { from: "out/worker", to: "environment-worker" },
    { from: "out/browser-worker", to: "browser-worker" },
    { from: "out/media-parser", to: "media-parser" },
  ],
  artifactName: "Aevoren-${version}-${arch}.${ext}",
  // Never let electron-builder infer a GitHub provider from package metadata
  // for unsigned local packages. Only signed release builds embed the feed.
  publish: publishConfiguration ? [publishConfiguration] : null,
  mac: {
    // macOS locale names differ from Windows/Linux .pak names. Keep those
    // platforms' complete locale sets so native inputs cannot crash Electron.
    electronLanguages: ["en", "zh_CN"],
    extraResources: [{ from: "out/native-mac", to: "native-mac" }],
    binaries: ["Contents/Resources/native-mac/computer-input"],
    target: ["dmg", "zip"],
    category: "public.app-category.productivity",
    icon: "resources/icon.icns",
    minimumSystemVersion: "13.0",
    extendInfo: { NSAccessibilityUsageDescription: "在你选择并授权后后台操作指定应用窗口。", NSScreenCaptureUsageDescription: "在你选择并授权后观察指定应用窗口。" },
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    ...(releaseBuild
      ? { hardenedRuntime: true, notarize: true }
      : { identity: null, hardenedRuntime: false, notarize: false }),
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "resources/icon.ico",
    ...(releaseBuild
      ? {
          forceCodeSigning: true,
        }
      : {}),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Aevoren",
    deleteAppDataOnUninstall: false,
  },
  dmg: {
    sign: releaseBuild,
  },
};
