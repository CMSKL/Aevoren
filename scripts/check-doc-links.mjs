import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const markdownFiles = tracked.filter((path) => extname(path).toLowerCase() === ".md" && existsSync(path));
const missing = [];
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/gu;

for (const file of markdownFiles) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(linkPattern)) {
    const raw = match[1]?.trim().replace(/^<|>$/gu, "") ?? "";
    if (!raw || raw.startsWith("#") || /^(?:https?:|mailto:|codex:)/iu.test(raw)) continue;
    const target = decodeURIComponent(raw.split("#", 1)[0] ?? "");
    const absoluteTarget = resolve(dirname(file), target);
    const publishedTarget = relative(resolve("."), absoluteTarget).split(sep).join("/");
    const published = publishedTarget === "" || tracked.some((path) => path === publishedTarget || path.startsWith(`${publishedTarget}/`));
    if (!existsSync(absoluteTarget) || !published) missing.push(`${file}: ${raw}`);
  }
}

if (missing.length > 0) throw new Error(`Broken local Markdown links:\n${missing.join("\n")}`);
process.stdout.write(`documentation link check passed files=${markdownFiles.length}\n`);
