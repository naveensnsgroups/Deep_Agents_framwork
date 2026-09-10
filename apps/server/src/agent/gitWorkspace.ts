import fs from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import { REPOS_DIR } from "./paths.js";

/**
 * Distinguishes "a GitHub repo to clone" from "a local folder path that already exists" —
 * `set_workspace` accepts either, so this is checked before deciding whether to resolve
 * via git or use the input directly as a filesystem path (see resolveWorkspaceRoot).
 */
export function isGitUrl(input: string): boolean {
  const trimmed = input.trim();
  return /^https?:\/\//.test(trimmed) || trimmed.startsWith("git@") || trimmed.endsWith(".git");
}

function parseGitTarget(input: string): { url: string; branch?: string } {
  const trimmed = input.trim();
  // "#branch" suffix, e.g. https://github.com/user/repo#feature-x — '#' can't otherwise
  // appear in a git remote URL, so this is unambiguous.
  const hashIdx = trimmed.indexOf("#");
  if (hashIdx === -1) return { url: trimmed };
  return { url: trimmed.slice(0, hashIdx), branch: trimmed.slice(hashIdx + 1) || undefined };
}

function slugFor(url: string, branch?: string): string {
  const base = url
    .replace(/^https?:\/\//, "")
    .replace(/^git@/, "")
    .replace(/\.git$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return branch ? `${base}--${branch.replace(/[^a-zA-Z0-9]+/g, "-")}` : base;
}

/** Embeds a token for one specific git command's remote argument — never written to
 * .git/config, since it's passed as an override rather than the configured "origin". */
function withToken(url: string, token?: string): string {
  if (!token || !url.startsWith("https://")) return url;
  return url.replace("https://", `https://x-access-token:${token}@`);
}

/**
 * Clones a GitHub repo into a managed directory on first use, or fetches+resets to the
 * latest commit on subsequent opens of the same repo+branch. The rest of the app (backend,
 * REST file routes, the terminal) then just treats the returned path as a normal directory
 * on this machine's disk — same as any local-folder workspace — because on a cloud
 * deployment that's exactly what it is: a real directory, just one the server created by
 * cloning rather than one that was already there.
 *
 * The token (if given) is only ever used as a one-off argument to clone/fetch, never
 * persisted into the repo's stored remote — see withToken.
 */
export async function resolveGitWorkspace(input: string, githubToken?: string): Promise<string> {
  const { url, branch } = parseGitTarget(input);
  const dir = path.join(REPOS_DIR, slugFor(url, branch));
  await fs.mkdir(REPOS_DIR, { recursive: true });

  const alreadyCloned = await fs
    .stat(path.join(dir, ".git"))
    .then((s) => s.isDirectory())
    .catch(() => false);

  const authedUrl = withToken(url, githubToken);

  if (alreadyCloned) {
    const repo = simpleGit(dir);
    const target = branch ?? (await repo.raw(["symbolic-ref", "--short", "HEAD"])).trim();
    await repo.fetch(authedUrl, target);
    // Reset (not pull/merge) — this is a working copy for the agent to operate on, not a
    // clone the user is expected to have local commits in; a clean reset avoids merge
    // conflicts against whatever the agent left behind last session.
    await repo.checkout(target).reset(["--hard", "FETCH_HEAD"]);
  } else {
    await simpleGit().clone(authedUrl, dir, branch ? ["--branch", branch] : []);
    // Overwrite the origin the clone just set (which embeds the token) with the plain
    // URL, so the token never sits in this repo's on-disk config after this point.
    await simpleGit(dir).remote(["set-url", "origin", url]);
  }

  return dir;
}

/**
 * Commits everything currently in the cloned workspace and pushes it back to its GitHub
 * remote. Manual and explicit (a button, not automatic after every turn) — the approval
 * gate already governs what the agent writes locally; pushing is a separate, deliberate
 * decision to publish those changes.
 */
export async function pushWorkspace(dir: string, message: string, githubToken?: string): Promise<{ pushed: boolean; detail: string }> {
  const repo = simpleGit(dir);
  const status = await repo.status();
  if (status.files.length === 0) return { pushed: false, detail: "Nothing to push — no changes in the workspace." };

  await repo.add(".");
  await repo.commit(message);

  const remotes = await repo.getRemotes(true);
  const origin = remotes.find((r) => r.name === "origin");
  if (!origin) return { pushed: false, detail: "Committed locally, but this workspace has no 'origin' remote to push to." };

  const branch = (await repo.raw(["symbolic-ref", "--short", "HEAD"])).trim();
  const pushUrl = withToken(origin.refs.push, githubToken);
  await repo.push(pushUrl, branch);
  return { pushed: true, detail: `Pushed to ${branch}.` };
}
