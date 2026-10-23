import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const required = [
  "LICENSE",
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "THIRD_PARTY_NOTICES.md",
  "NOTICE",
  ".github/workflows/ci.yml",
  ".github/pull_request_template.md",
];
const findings = required.filter((path) => !existsSync(path)).map((path) => `missing required file: ${path}`);
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
if (typeof packageJson.license !== "string" || !packageJson.license.trim()) findings.push("package.json is missing a license identifier");
const assetProvenance = readFileSync("NOTICE", "utf8");
if (!assetProvenance.includes("## Maintainer redistribution attestation")) {
  findings.push("the current application icon is missing a maintainer redistribution attestation");
}

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const internal = tracked.filter((path) => (
  path === "design-qa.md" ||
  path.startsWith("docs/")
));
if (internal.length > 0) findings.push(`local-only documentation or internal design files remain tracked: ${internal.length} files`);

const macUserPrefix = ["", "Users", ""].join("/");
const personalPathFiles = tracked.filter((path) => {
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, "utf8").includes(macUserPrefix);
  } catch {
    return false;
  }
});
if (personalPathFiles.length > 0) findings.push(`absolute personal paths remain tracked: ${personalPathFiles.join(", ")}`);

if (findings.length > 0) {
  process.stderr.write(`open-source readiness blocked:\n- ${findings.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("open-source readiness file gate passed\n");
}
