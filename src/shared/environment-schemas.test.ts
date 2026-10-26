import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ENVIRONMENT_OPERATION_SCHEMAS } from "./environment-product";
import { environmentDirectoryPathSchema, environmentFilePathSchema } from "./environment-schemas";

describe("isolated environment path discovery", () => {
  it("exposes relative path requirements in the exact JSON schemas shown to models", () => {
    const run = z.toJSONSchema(ENVIRONMENT_OPERATION_SCHEMAS["execution.run"]!, { unrepresentable: "any", io: "input" });
    const read = z.toJSONSchema(ENVIRONMENT_OPERATION_SCHEMAS["execution.readFile"]!, { unrepresentable: "any", io: "input" });
    expect(run.properties?.cwd).toMatchObject({ description: expect.stringContaining("Use '.' or omit cwd") });
    expect(read.properties?.path).toMatchObject({ description: expect.stringContaining("relative to this isolated environment's /workspace") });
  });

  it.each(["/workspace", "../other", "C:\\Users\\private", "folder/../private"])("still rejects unsafe cwd %s", path => {
    expect(environmentDirectoryPathSchema.safeParse(path).success).toBe(false);
    expect(environmentFilePathSchema.safeParse(path).success).toBe(false);
  });

  it("accepts the root directory marker and scoped relative paths", () => {
    expect(environmentDirectoryPathSchema.parse(".")).toBe(".");
    expect(environmentDirectoryPathSchema.parse("visual/src")).toBe("visual/src");
    expect(environmentFilePathSchema.parse("visual/cover.png")).toBe("visual/cover.png");
  });
});
