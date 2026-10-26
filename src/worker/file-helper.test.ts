import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EnvironmentFileContent, EnvironmentFileWriteResult } from "@shared/environment-contracts";
import { fileOperation } from "./file-helper";

const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "aevoren-worker-files-")); roots.push(root); const workspace = join(root, "workspace"); mkdirSync(workspace); return { root, workspace }; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("unprivileged Worker file operations", () => {
  it("writes a nested binary file, verifies its digest and requires a matching digest before replacement", async () => {
    const f = fixture(); const bytes = Buffer.from([0, 255, 128, 42]);
    const first = await fileOperation(f.workspace, { action: "write", path: "nested/data.bin", content: bytes.toString("base64"), encoding: "base64" }) as EnvironmentFileWriteResult;
    const read = await fileOperation(f.workspace, { action: "read", path: first.path }) as EnvironmentFileContent;
    expect(Buffer.from(read.content, "base64")).toEqual(bytes);
    expect(read.sha256).toBe(first.sha256);
    await expect(fileOperation(f.workspace, { action: "write", path: first.path, content: "different" })).rejects.toMatchObject({ code: "WORKER_FILE_CONFLICT" });
    await expect(fileOperation(f.workspace, { action: "write", path: first.path, content: "different", expectedSha256: "a".repeat(64) })).rejects.toMatchObject({ code: "WORKER_FILE_CONFLICT" });
    await fileOperation(f.workspace, { action: "write", path: first.path, content: "different", expectedSha256: first.sha256 });
    expect((await fileOperation(f.workspace, { action: "read", path: first.path }) as EnvironmentFileContent).content).toBe("different");
  });
  it.each([
    { action: "read" as const, path: "missing.txt" },
    { action: "read" as const, path: "missing-parent/file.txt" },
    { action: "list" as const, path: "missing-parent/nested" },
    { action: "directory" as const, path: "missing-parent/nested" },
    { action: "write" as const, path: "missing-parent/file.txt", content: "replacement", expectedSha256: "a".repeat(64) },
  ])("reports missing scoped targets without exposing filesystem errors: $action $path", async input => {
    const f = fixture();
    const error = await fileOperation(f.workspace, input).catch(error => error);
    expect(error).toMatchObject({ code: "WORKER_FILE_NOT_FOUND", status: 404, message: "WORKER_FILE_NOT_FOUND", details: {} });
    expect(String(error)).not.toContain(f.root);
    expect(existsSync(join(f.workspace, input.path))).toBe(false);
    expect(readdirSync(f.workspace)).toEqual([]);
  });
  it("preserves existing bytes and removes temporary uploads after create-only or digest conflicts", async () => {
    const f = fixture(); writeFileSync(join(f.workspace, "existing.txt"), "original");
    for (const expectedSha256 of [undefined, "a".repeat(64)]) {
      await expect(fileOperation(f.workspace, { action: "write", path: "existing.txt", content: "replacement", expectedSha256 })).rejects.toMatchObject({ code: "WORKER_FILE_CONFLICT", status: 409 });
      expect((await fileOperation(f.workspace, { action: "read", path: "existing.txt" }) as EnvironmentFileContent).content).toBe("original");
      expect(readdirSync(f.workspace)).toEqual(["existing.txt"]);
    }
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("distinguishes denied reads, lists and writes from missing files", async () => {
    const f = fixture(), restricted = join(f.workspace, "restricted"); mkdirSync(restricted); writeFileSync(join(restricted, "private.txt"), "private");
    chmodSync(restricted, 0);
    try {
      for (const action of ["read", "list", "write"] as const) {
        await expect(fileOperation(f.workspace, { action, path: action === "list" ? "restricted" : "restricted/private.txt", content: "replacement" })).rejects.toMatchObject({ code: "WORKER_FILE_ACCESS_DENIED", status: 403, message: "WORKER_FILE_ACCESS_DENIED", details: {} });
      }
    } finally { chmodSync(restricted, 0o700); }
  });
  it.each(["../private", "/etc/passwd", "..\\private", "C:/private", "."])("rejects unsafe file path %s", async path => {
    const f = fixture(); await expect(fileOperation(f.workspace, { action: "read", path })).rejects.toMatchObject({ code: "WORKER_PATH_INVALID" });
  });
  it("bounds real file bytes and rejects malformed base64", async () => {
    const f = fixture(); writeFileSync(join(f.workspace, "large.bin"), Buffer.alloc(1_048_577));
    await expect(fileOperation(f.workspace, { action: "read", path: "large.bin" })).rejects.toMatchObject({ code: "WORKER_FILE_TOO_LARGE" });
    await expect(fileOperation(f.workspace, { action: "write", path: "bad.bin", content: "bad!", encoding: "base64" })).rejects.toMatchObject({ code: "WORKER_INVALID_REQUEST" });
  });
  it.skipIf(process.platform === "win32")("rejects direct and ancestor symlinks without reading external bytes", async () => {
    const f = fixture(); writeFileSync(join(f.root, "private"), "PRIVATE_FIXTURE");
    symlinkSync(join(f.root, "private"), join(f.workspace, "link.txt"));
    symlinkSync(f.root, join(f.workspace, "linked-directory"));
    await expect(fileOperation(f.workspace, { action: "read", path: "link.txt" })).rejects.toMatchObject({ code: "WORKER_PATH_INVALID" });
    await expect(fileOperation(f.workspace, { action: "read", path: "linked-directory/private" })).rejects.toMatchObject({ code: "WORKER_PATH_INVALID" });
    await expect(fileOperation(f.workspace, { action: "write", path: "linked-directory/other.txt", content: "must not write" })).rejects.toMatchObject({ code: "WORKER_PATH_INVALID" });
    symlinkSync(join(f.root, "missing-directory"), join(f.workspace, "dangling-directory"));
    symlinkSync(join(f.root, "missing-file"), join(f.workspace, "dangling-file"));
    for (const path of ["linked-directory/missing/child", "dangling-directory/child", "dangling-file"]) {
      await expect(fileOperation(f.workspace, { action: "read", path })).rejects.toMatchObject({ code: "WORKER_PATH_INVALID" });
      await expect(fileOperation(f.workspace, { action: "write", path, content: "must not write" })).rejects.toMatchObject({ code: path === "dangling-file" ? "WORKER_FILE_CONFLICT" : "WORKER_PATH_INVALID" });
    }
    await expect(fileOperation(f.workspace, { action: "list", path: "linked-directory/missing/child" })).rejects.toMatchObject({ code: "WORKER_PATH_INVALID" });
    await expect(fileOperation(f.workspace, { action: "write", path: "linked-directory/missing/child", content: "must not write", expectedSha256: "a".repeat(64) })).rejects.toMatchObject({ code: "WORKER_PATH_INVALID" });
    expect(existsSync(join(f.root, "missing"))).toBe(false);
    expect(existsSync(join(f.root, "missing-directory"))).toBe(false);
    expect(existsSync(join(f.root, "missing-file"))).toBe(false);
  });
});
