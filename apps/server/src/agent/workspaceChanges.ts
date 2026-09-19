import { simpleGit } from "simple-git";
import type { ChangedFile, WorkspaceChanges } from "@deepagents-ide/shared";
import { runInSandbox, type E2BSandbox } from "./e2bSandbox.js";
import { E2B_PROJECT_DIR } from "./sandboxSession.js";

/**
 * What the working tree changed since the last commit — the agent's writes, edits and deletes,
 * and anything its shell commands touched (an install, a codemod, a `sed`), which a record of
 * the file tools alone would miss. It is also exactly what Push would commit, so this is the
 * review before pushing.
 */

/** More than this is a generated or vendored directory, not something to review file by file. */
export const MAX_CHANGED_FILES = 500;
/** Past this the original is not sent for a diff; a file that large is not reviewed line by line. */
export const MAX_DIFF_BYTES = 1024 * 1024;

const STATUS_ARGS = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];

/**
 * Parses `git status --porcelain=v1 -z`. NUL-separated so a path with spaces, quotes or a newline
 * comes through verbatim. Each entry is two status letters, a space, and the path; a rename or
 * copy is followed by one extra entry holding the path it came from.
 */
export function parseStatus(output: string): ChangedFile[] {
  const entries = output.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const path = entry.slice(3);

    if (code.includes("R") || code.includes("C")) {
      const from = entries[++i];
      files.push({ path, status: "renamed", from });
    } else if (code === "??" || code.includes("A")) {
      files.push({ path, status: "added" });
    } else if (code.includes("D")) {
      files.push({ path, status: "deleted" });
    } else {
      files.push({ path, status: "modified" });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function summarize(files: ChangedFile[]): WorkspaceChanges {
  return files.length > MAX_CHANGED_FILES
    ? { available: true, files: files.slice(0, MAX_CHANGED_FILES), truncated: files.length }
    : { available: true, files };
}

const NOT_A_REPO: WorkspaceChanges = {
  available: false,
  files: [],
  reason: "This folder is not the root of a git repository, so there is nothing to compare the changes against.",
};

/**
 * `git show HEAD:<path>` reads the path relative to the repository root, whatever the working
 * directory. Refusing anything that climbs or is absolute keeps it to the project's own files.
 */
function assertRelative(path: string): void {
  if (!path || path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:/.test(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error("Invalid path");
  }
}

function asText(content: string): string | null {
  return content.length > MAX_DIFF_BYTES || content.includes("\0") ? null : content;
}

export async function localChanges(dir: string): Promise<WorkspaceChanges> {
  const repo = simpleGit(dir);
  // The folder itself must be the repository root. Inside a larger repository, status would
  // list — and Push would commit — changes that are not part of this workspace.
  const top = await repo.revparse(["--show-toplevel"]).catch(() => null);
  if (!top || !samePath(top, dir)) return NOT_A_REPO;
  return summarize(parseStatus(await repo.raw(STATUS_ARGS)));
}

/** The committed version of a file, or null when it is new, binary or too large to diff. */
export async function localOriginal(dir: string, path: string): Promise<string | null> {
  assertRelative(path);
  const content = await simpleGit(dir)
    .show([`HEAD:${path.replace(/\\/g, "/")}`])
    .catch(() => null);
  return content === null ? null : asText(content);
}

export async function sandboxChanges(sandbox: E2BSandbox): Promise<WorkspaceChanges> {
  const e2b = await sandbox.ready();
  const result = await runInSandbox(e2b, `git ${STATUS_ARGS.join(" ")}`, { cwd: E2B_PROJECT_DIR });
  if (result.exitCode !== 0) return NOT_A_REPO;
  return summarize(parseStatus(result.stdout));
}

export async function sandboxOriginal(sandbox: E2BSandbox, path: string): Promise<string | null> {
  assertRelative(path);
  const e2b = await sandbox.ready();
  const result = await runInSandbox(e2b, `git show ${shellQuote(`HEAD:${path}`)}`, { cwd: E2B_PROJECT_DIR });
  return result.exitCode === 0 ? asText(result.stdout) : null;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const slashed = p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
    // Windows paths are case-insensitive, and git reports the drive letter in its own case.
    return process.platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  return norm(a) === norm(b);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
