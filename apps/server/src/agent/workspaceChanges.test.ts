import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { simpleGit } from "simple-git";
import { localChanges, localOriginal, MAX_CHANGED_FILES, parseStatus } from "./workspaceChanges.js";

describe("parseStatus", () => {
  it("reads every kind of change, including paths with spaces and renames", () => {
    const output = [" M src/app.ts", "?? docs/new file.md", " D old.js", "A  staged.ts", "R  to.ts", "from.ts", ""].join("\0");
    expect(parseStatus(output)).toEqual([
      { path: "docs/new file.md", status: "added" },
      { path: "old.js", status: "deleted" },
      { path: "src/app.ts", status: "modified" },
      { path: "staged.ts", status: "added" },
      { path: "to.ts", status: "renamed", from: "from.ts" },
    ]);
  });

  it("returns nothing for a clean tree", () => {
    expect(parseStatus("")).toEqual([]);
  });
});

describe("local workspace changes", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "changes-"));
    const repo = simpleGit(dir);
    await repo.init();
    await repo.addConfig("user.name", "test").addConfig("user.email", "test@example.com").addConfig("core.autocrlf", "false");
    await fs.writeFile(path.join(dir, "keep.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(dir, "gone.ts"), "export const b = 2;\n");
    await repo.add(".").commit("initial");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("lists what changed since the last commit, whatever made the change", async () => {
    await fs.writeFile(path.join(dir, "keep.ts"), "export const a = 2;\n");
    await fs.rm(path.join(dir, "gone.ts"));
    await fs.mkdir(path.join(dir, "src"));
    await fs.writeFile(path.join(dir, "src", "new.ts"), "export {};\n");

    expect(await localChanges(dir)).toEqual({
      available: true,
      files: [
        { path: "gone.ts", status: "deleted" },
        { path: "keep.ts", status: "modified" },
        { path: "src/new.ts", status: "added" },
      ],
    });
  });

  it("gives the committed version as the original, and none for a new file", async () => {
    await fs.writeFile(path.join(dir, "keep.ts"), "changed\n");
    await fs.writeFile(path.join(dir, "fresh.ts"), "new\n");
    expect(await localOriginal(dir, "keep.ts")).toBe("export const a = 1;\n");
    expect(await localOriginal(dir, "fresh.ts")).toBeNull();
  });

  it("sends no original for a binary file", async () => {
    await fs.writeFile(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    await simpleGit(dir).add(".").commit("binary");
    expect(await localOriginal(dir, "logo.png")).toBeNull();
  });

  it.each(["../outside.txt", "/etc/passwd", "C:\\Windows\\win.ini", "a/../../b", ""])("refuses the path %s", async (bad) => {
    await expect(localOriginal(dir, bad)).rejects.toThrow("Invalid path");
  });

  it("cuts a very long list short and says how long it was", async () => {
    await fs.mkdir(path.join(dir, "generated"));
    await Promise.all(
      Array.from({ length: MAX_CHANGED_FILES + 5 }, (_, i) => fs.writeFile(path.join(dir, "generated", `f${i}.txt`), `${i}`))
    );
    const changes = await localChanges(dir);
    expect(changes.files).toHaveLength(MAX_CHANGED_FILES);
    expect(changes.truncated).toBe(MAX_CHANGED_FILES + 5);
  });

  it("is unavailable outside a repository", async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), "plain-"));
    try {
      expect(await localChanges(plain)).toMatchObject({ available: false, files: [] });
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });

  // Push commits the whole repository, so a subfolder would show — and push — someone else's changes.
  it("is unavailable for a folder inside a larger repository", async () => {
    await fs.mkdir(path.join(dir, "sub"));
    await fs.writeFile(path.join(dir, "keep.ts"), "outside the subfolder\n");
    expect(await localChanges(path.join(dir, "sub"))).toMatchObject({ available: false });
  });
});
