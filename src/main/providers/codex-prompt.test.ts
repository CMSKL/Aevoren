import { describe, expect, it } from "vitest";
import { promptParts } from "./codex-cli";

describe("Codex prompt tool boundaries", () => {
  it("allows scoped dynamic-tool commands and file operations without granting native host tools", () => {
    const prompt = promptParts([{ role: "system", content: "Control only the isolated Linux computer." }, { role: "user", content: "Render a cover inside that computer." }], true);
    expect(prompt.developerInstructions).toContain("Never use Codex's native shell commands, native file editing or built-in browsing");
    expect(prompt.developerInstructions).toContain("Host-provided dynamic tools may run commands and read/write files only inside their declared isolated Linux or application-managed scope");
    expect(prompt.developerInstructions).toContain("does not grant host filesystem or host shell access");
    expect(prompt.developerInstructions).not.toContain("Do not run shell commands, edit files");
    expect(prompt.input).toBe("[user]\nRender a cover inside that computer.");
  });

  it("still prohibits all tools when no structured host tools are supplied", () => {
    const prompt = promptParts([{ role: "user", content: "Explain a cover design." }]);
    expect(prompt.developerInstructions).toContain("Do not run shell commands, edit files, browse, or call tools");
    expect(prompt.developerInstructions).not.toContain("dynamic tools may run commands");
  });
});
