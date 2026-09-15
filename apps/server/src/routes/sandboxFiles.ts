import path from "node:path";
import type { FileNode } from "@deepagents-ide/shared";
import type { E2BSandbox } from "../agent/e2bSandbox.js";
import { E2B_PROJECT_DIR } from "../agent/sandboxSession.js";

/** Mirrors the local tree walker's exclusions so both modes show the same shape of project. */
const PRUNED = ["node_modules", ".git", "dist", "build", ".next"];
const MAX_DEPTH = 6;

/**
 * Builds the file tree from inside the sandbox.
 *
 * One `find` rather than a recursive walk over the protocol: every `ls` is a round trip to
 * the microVM, so walking a real repository directory by directory would take hundreds of
 * them. `-printf` marks each entry's type in the same pass, which is what lets the tree be
 * assembled without a second call per path to ask whether it is a directory.
 */
export async function sandboxTree(sandbox: E2BSandbox): Promise<FileNode[]> {
  const e2b = await sandbox.ready();
  const prune = PRUNED.map((name) => `-name ${quote(name)}`).join(" -o ");

  const result = await e2b.commands.run(
    `find . -maxdepth ${MAX_DEPTH} \\( ${prune} \\) -prune -o -printf '%y\\t%P\\n'`,
    { cwd: E2B_PROJECT_DIR }
  );
  if (result.exitCode !== 0) throw new Error(result.stderr || "Could not list the sandbox workspace");

  const root: FileNode[] = [];
  const dirs = new Map<string, FileNode[]>([["", root]]);

  // Sorted so a directory is always created before anything inside it, making the parent
  // lookup below a plain map read rather than a recursive insert.
  const entries = result.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([type, rel]) => rel && type && !rel.split("/").some((seg) => seg.startsWith(".")))
    .sort((a, b) => a[1].localeCompare(b[1]));

  for (const [type, rel] of entries) {
    const parent = dirs.get(path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel));
    if (!parent) continue; // parent was pruned or filtered out — so is everything beneath it

    const node: FileNode =
      type === "d"
        ? { name: path.posix.basename(rel), path: rel, type: "dir", children: [] }
        : { name: path.posix.basename(rel), path: rel, type: "file" };

    parent.push(node);
    if (node.type === "dir") dirs.set(rel, node.children as FileNode[]);
  }

  sortTree(root);
  return root;
}

/** Directories first, then alphabetical — same ordering the local tree uses. */
function sortTree(nodes: FileNode[]): void {
  nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  for (const node of nodes) if (node.type === "dir" && node.children) sortTree(node.children);
}

export async function sandboxReadFile(sandbox: E2BSandbox, relPath: string): Promise<string> {
  const e2b = await sandbox.ready();
  return e2b.files.read(resolveInProject(relPath), { format: "text" });
}

/**
 * The sandbox is disposable, but it also holds the GitHub token's clone and whatever the
 * agent wrote, so a path from the client is still confined to the project directory rather
 * than being allowed to wander to `/etc` or the home directory.
 */
function resolveInProject(relPath: string): string {
  const resolved = path.posix.resolve(E2B_PROJECT_DIR, relPath || ".");
  const rel = path.posix.relative(E2B_PROJECT_DIR, resolved);
  if (rel.startsWith("..") || path.posix.isAbsolute(rel)) {
    throw new Error("Path escapes workspace root");
  }
  return resolved;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
