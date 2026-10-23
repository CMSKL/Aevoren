import { describe, expect, it } from "vitest";
import { requestedReadPaths } from "./workspace-read-requirements";

describe("explicit workspace read requirements", () => {
  it.each([
    ["读取license-note.md和USER_GUIDE.md→guide-note.md", ["license-note.md", "USER_GUIDE.md"]],
    ["实际完整读取相对路径research/competitors.md及research/sources.csv，maxBytes=1048576。", ["research/competitors.md", "research/sources.csv"]],
    ["读取 research/competitors.md和research/sources.csv。", ["research/competitors.md", "research/sources.csv"]],
    ["读取 research/competitors.md与research/sources.csv。", ["research/competitors.md", "research/sources.csv"]],
    ["读取 research/competitors.md以及research/sources.csv。", ["research/competitors.md", "research/sources.csv"]],
    ["读取 研究/source.md 及 资料/result.csv。", ["研究/source.md", "资料/result.csv"]],
    ["读取 `相对路径research/competitors.md及research/sources.csv`。", ["相对路径research/competitors.md及research/sources.csv"]],
    ["先真实读取当前工作区的 LICENSE.md，将摘要新建为 license-note.md；然后读取 license-note.md 和 USER_GUIDE.md，将用途整理为 guide-note.md。", ["LICENSE.md", "license-note.md", "USER_GUIDE.md"]],
    ["Read `docs/source.md` and `USER_GUIDE.md`, then write guide-note.md.", ["docs/source.md", "USER_GUIDE.md"]],
    ["读取 `来源.md`，然后保存 output.md。", ["来源.md"]],
    ["读取 LICENSE 和 README，再新建 note.md", ["LICENSE", "README"]],
    ["创建 story.md，原创一个故事。", []],
    ["写入 report.md，保存后读取 report.md 核验。", ["report.md"]],
    ["阅读 https://example.com/docs/page.md 并生成 note.md", []],
    ["不要读取 secret.md，只写新文档。", []],
    ["Do not read private.csv. Create a new note.md instead.", []],
    ["Don't read private.csv; read public.md and write note.md.", ["public.md"]],
    ["无需读取 secret.md；请读取 public.md 后写入 note.md。", ["public.md"]],
    ["不得启动、导航、读取 secret.md 或输入。", []],
    ["Do not restart, navigate, read private.md, or write files.", []],
    ["不要写入 secret.md，但请读取 public.md。", ["public.md"]],
    ["如果启动成功，再读取 result.md。", []],
    ["请读取“不要启动.md”。", ["不要启动.md"]],
    ["Read docs/if.md.", ["docs/if.md"]],
    ["例如：读取 secret.md，然后保存 note.md。", []],
    ["请解释“读取 secret.md”的含义，不执行示例。", []],
    ["文档中写着读取 secret.md，请说明这句话。", []],
    ["解释代码示例：```\nread private.csv\n```\n只写新文档。", []],
    ["Explain `read private.csv` without executing it.", []],
    ["请读取 `read.md` 和 USER_GUIDE.md，再写入 guide-note.md。", ["USER_GUIDE.md", "read.md"]],
  ])("extracts only named sources from %s", (input, expected) => {
    expect(requestedReadPaths(input as string)).toEqual(expected);
  });
});
