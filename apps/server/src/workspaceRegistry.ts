import path from "node:path";
import { isCloudMode } from "./auth.js";

/**
 * Every directory the server has itself decided to open as a workspace, and who opened it.
 *
 * The REST file routes and the terminal used to take their root directly from the caller,
 * which meant the "stay inside the root" checks were validating a path against a root the
 * same caller had just chosen — no constraint at all. Roots now only ever enter this map
 * through `set_workspace`, which either resolves a git URL into a directory the server
 * created or accepts a local path from an operator-configured session; everything else
 * validates against what is already in here.
 *
 * Recorded per owner, so one signed-in user cannot read or open a terminal in a workspace
 * another user opened just by knowing its path. Without separate accounts every caller is the
 * same owner and this behaves as a single shared set.
 *
 * Process-local and unbounded: a workspace stays open for as long as the server runs, which
 * matches how the rest of the app treats sessions (in memory, cleared on restart).
 */
const allowedRoots = new Map<string, Set<string>>();

/**
 * On a cloud deployment this server's own disk holds its secrets and every user's data, so no
 * directory on it may become a workspace — the agent's tools, the file routes and the terminal
 * would all run against the host. Work happens only in E2B sandboxes there. Enforced here
 * because every host workspace passes through this one function.
 */
export function assertHostWorkspacesAllowed(): void {
  if (isCloudMode()) {
    throw new Error("This deployment only opens GitHub repositories. Enter a URL like https://github.com/owner/repo.");
  }
}

export function allowWorkspaceRoot(root: string, ownerId: string): string {
  assertHostWorkspacesAllowed();
  const resolved = path.resolve(root);
  let owners = allowedRoots.get(resolved);
  if (!owners) allowedRoots.set(resolved, (owners = new Set()));
  owners.add(ownerId);
  return resolved;
}

export function isWorkspaceRoot(root: string, ownerId: string): boolean {
  return allowedRoots.get(path.resolve(root))?.has(ownerId) ?? false;
}

/**
 * True when `target` is the root itself or sits underneath it.
 *
 * `resolved.startsWith(root)` — the previous check — is a string comparison, so a root of
 * `/srv/app` also accepted `/srv/app-secrets`. Going through `path.relative` compares path
 * segments instead: anything outside the root produces a result that escapes upward or is
 * absolute, neither of which can appear in a genuine descendant.
 */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolves a path that arrived from a client against a workspace the server opened,
 * throwing unless both the root is one we know and the result stays inside it.
 */
export function resolveInWorkspace(root: string, relPath: string, ownerId: string): string {
  if (!isWorkspaceRoot(root, ownerId)) {
    throw new Error("Unknown workspace root");
  }
  const resolved = path.resolve(root, relPath || ".");
  if (!isInside(root, resolved)) {
    throw new Error("Path escapes workspace root");
  }
  return resolved;
}
