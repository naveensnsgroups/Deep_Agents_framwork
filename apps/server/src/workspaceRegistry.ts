import path from "node:path";

/**
 * Every directory the server has itself decided to open as a workspace.
 *
 * The REST file routes and the terminal used to take their root directly from the caller,
 * which meant the "stay inside the root" checks were validating a path against a root the
 * same caller had just chosen — no constraint at all. Roots now only ever enter this set
 * through `set_workspace`, which either resolves a git URL into a directory the server
 * created or accepts a local path from an operator-configured session; everything else
 * validates against what is already in here.
 *
 * Process-local and unbounded: a workspace stays open for as long as the server runs, which
 * matches how the rest of the app treats sessions (in memory, cleared on restart). Once
 * there are real user accounts this should become per-user rather than global — until then
 * it is a guard against arbitrary paths, not against one user reaching another's workspace.
 */
const allowedRoots = new Set<string>();

export function allowWorkspaceRoot(root: string): string {
  const resolved = path.resolve(root);
  allowedRoots.add(resolved);
  return resolved;
}

export function isWorkspaceRoot(root: string): boolean {
  return allowedRoots.has(path.resolve(root));
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
export function resolveInWorkspace(root: string, relPath: string): string {
  if (!isWorkspaceRoot(root)) {
    throw new Error("Unknown workspace root");
  }
  const resolved = path.resolve(root, relPath || ".");
  if (!isInside(root, resolved)) {
    throw new Error("Path escapes workspace root");
  }
  return resolved;
}
