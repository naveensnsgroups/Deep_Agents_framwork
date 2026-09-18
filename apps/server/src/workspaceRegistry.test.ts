import { describe, expect, it } from "vitest";
import path from "node:path";
import { allowWorkspaceRoot, isInside, isWorkspaceRoot, resolveInWorkspace } from "./workspaceRegistry.js";

/**
 * These guard the fix for an arbitrary-file-read: `/api/file` used to take its root from the
 * query string, so the containment check validated a path against a root the same caller had
 * chosen. A regression here re-opens reading any file on the server.
 */
describe("workspace containment", () => {
  const root = path.resolve("/srv/app");

  it("accepts the root itself and paths beneath it", () => {
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, path.resolve("/srv/app/src/index.ts"))).toBe(true);
    expect(isInside(root, path.resolve("/srv/app/a/b/c.txt"))).toBe(true);
  });

  it("rejects a sibling whose name merely starts with the root", () => {
    // The original check was `resolved.startsWith(root)`, which accepted these.
    expect(isInside(root, path.resolve("/srv/app-secrets/key.pem"))).toBe(false);
    expect(isInside(root, path.resolve("/srv/application/x"))).toBe(false);
  });

  it("rejects traversal out of the root", () => {
    expect(isInside(root, path.resolve("/srv/app/../../etc/passwd"))).toBe(false);
    expect(isInside(root, path.resolve("/etc/passwd"))).toBe(false);
  });
});

describe("workspace registry", () => {
  it("only trusts roots the server itself opened", () => {
    const unknown = path.resolve("/tmp/not-opened-by-us");
    expect(isWorkspaceRoot(unknown, "alice")).toBe(false);
    expect(() => resolveInWorkspace(unknown, "anything.txt", "alice")).toThrow(/Unknown workspace root/);
  });

  it("accepts a registered root regardless of how it is spelled back", () => {
    const opened = allowWorkspaceRoot(path.join(path.resolve("/srv/opened"), "sub", ".."), "alice");
    expect(isWorkspaceRoot(opened, "alice")).toBe(true);
    // Trailing separators and redundant segments must still resolve to the same workspace,
    // because the client echoes this string back over HTTP.
    expect(isWorkspaceRoot(path.resolve("/srv/opened/"), "alice")).toBe(true);
    expect(isWorkspaceRoot(path.resolve("/srv/opened/./"), "alice")).toBe(true);
  });

  it("blocks traversal even from a registered root", () => {
    allowWorkspaceRoot(path.resolve("/srv/opened2"), "alice");
    expect(() => resolveInWorkspace(path.resolve("/srv/opened2"), "../../etc/passwd", "alice")).toThrow(
      /escapes workspace root/
    );
  });

  it("resolves a legitimate file inside a registered root", () => {
    const opened = allowWorkspaceRoot(path.resolve("/srv/opened3"), "alice");
    expect(resolveInWorkspace(opened, "src/main.ts", "alice")).toBe(path.resolve("/srv/opened3/src/main.ts"));
  });

  // With GitHub login, knowing another user's workspace path must not be enough to read it.
  it("does not let one user reach a workspace another user opened", () => {
    const opened = allowWorkspaceRoot(path.resolve("/srv/alice-project"), "gh:1");
    expect(isWorkspaceRoot(opened, "gh:2")).toBe(false);
    expect(() => resolveInWorkspace(opened, "secrets.env", "gh:2")).toThrow(/Unknown workspace root/);

    allowWorkspaceRoot(opened, "gh:2");
    expect(isWorkspaceRoot(opened, "gh:1")).toBe(true);
    expect(isWorkspaceRoot(opened, "gh:2")).toBe(true);
  });
});
