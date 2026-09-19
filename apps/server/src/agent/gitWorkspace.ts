import fs from "node:fs/promises";
import path from "node:path";
import { simpleGit } from "simple-git";
import { REPOS_DIR } from "./paths.js";
import { runInSandbox, type E2BSandbox } from "./e2bSandbox.js";
import { E2B_PROJECT_DIR } from "./sandboxSession.js";

/**
 * Distinguishes "a GitHub repo to clone" from "a local folder path that already exists" —
 * `set_workspace` accepts either, so this is checked before deciding whether to resolve
 * via git or use the input directly as a filesystem path (see resolveWorkspaceRoot).
 */
export function isGitUrl(input: string): boolean {
  const trimmed = input.trim();
  return /^https?:\/\//.test(trimmed) || trimmed.startsWith("git@") || trimmed.endsWith(".git");
}

/**
 * A token pasted into the URL (`https://ghp_…@github.com/…`) would be written into the clone's
 * `.git/config` — readable by the agent and anything injected into it — and would also become
 * part of the stored thread id. Refused outright rather than stripped, so the user moves it to
 * the token field instead of believing a credential-bearing URL is safe to keep using.
 */
export function assertNoEmbeddedCredentials(input: string): void {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return; // not a URL (a local path, or git@host:repo SSH form) — nothing to check
  }
  if (parsed.username || parsed.password) {
    throw new Error("The repository URL contains credentials. Remove them from the URL and enter the token in the GitHub token field instead.");
  }
}

/** GitHub's own rules: owners are 1-39 alphanumerics or single hyphens, repos are [A-Za-z0-9._-]. */
const GITHUB_REPO_URL = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;
/** A branch that git will only ever read as a ref: never an option (`-…`), never a path climb. */
const BRANCH_NAME = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

const UNSUPPORTED_REPO =
  "Only GitHub repositories are supported. Enter a URL like https://github.com/owner/repo (add #branch-name for a specific branch).";

/**
 * Everything typed here ends up as an argument to `git`, and "anything ending in .git" also
 * matched strings git reads as options or non-GitHub transports. Only the one shape the app
 * actually supports gets through.
 */
function parseGitTarget(input: string): { url: string; branch?: string } {
  assertNoEmbeddedCredentials(input);
  const trimmed = input.trim();
  // "#branch" suffix, e.g. https://github.com/user/repo#feature-x — '#' can't otherwise
  // appear in a git remote URL, so this is unambiguous.
  const hashIdx = trimmed.indexOf("#");
  const url = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx);
  const branch = hashIdx === -1 ? undefined : trimmed.slice(hashIdx + 1) || undefined;

  const match = GITHUB_REPO_URL.exec(url);
  if (!match || match[2] === "." || match[2] === "..") throw new Error(UNSUPPORTED_REPO);
  if (branch !== undefined && !BRANCH_NAME.test(branch)) throw new Error(`"${branch}" is not a valid branch name.`);
  return { url, branch };
}

/** Rejects anything but a GitHub repository URL, before a sandbox is booted for it. */
export function assertGitHubRepo(input: string): void {
  parseGitTarget(input);
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
export async function resolveGitWorkspace(input: string, githubToken?: string, owner?: string): Promise<string> {
  const { url, branch } = parseGitTarget(input);
  // Per owner under GitHub login: two users opening the same repository must not share one
  // working copy, or each would see — and push — the other's uncommitted edits.
  const parent = owner ? path.join(REPOS_DIR, owner.replace(/[^a-zA-Z0-9]+/g, "-")) : REPOS_DIR;
  const dir = path.join(parent, slugFor(url, branch));
  await fs.mkdir(parent, { recursive: true });

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
 * The sandbox equivalent of resolveGitWorkspace: clones straight into the microVM, so the
 * repository only ever exists on the disposable machine that runs the agent's commands and
 * never touches this server.
 *
 * Only ever called on a brand-new sandbox — a reconnected one already has the project (see
 * acquireSandbox) — so the clone is always the first thing in it.
 */
export async function cloneIntoSandbox(sandbox: E2BSandbox, input: string, githubToken?: string): Promise<void> {
  const { url, branch } = parseGitTarget(input);
  const e2b = await sandbox.ready();

  const branchArg = branch ? `--branch ${shellQuote(branch)} ` : "";
  const result = await runInSandbox(
    e2b,
    `git ${credentialArgs(githubToken)}clone ${branchArg}${shellQuote(url)} ${shellQuote(E2B_PROJECT_DIR)}`,
    { envs: gitEnv(githubToken) }
  );

  if (result.exitCode !== 0) {
    // The token can only reach this output via git's own error text, which reports the
    // remote without credentials — but scrub anyway rather than risk echoing it to the UI.
    throw new Error(`git clone failed in sandbox: ${scrub(result.stderr || result.stdout, githubToken)}`);
  }
}

/**
 * Commits and pushes from inside the sandbox. Mirrors pushWorkspace's contract — including
 * reporting "nothing to push" rather than making an empty commit — but every command runs in
 * the microVM, because that is where the agent's edits actually are.
 */
export async function pushFromSandbox(
  sandbox: E2BSandbox,
  message: string,
  githubToken?: string
): Promise<{ pushed: boolean; detail: string }> {
  const e2b = await sandbox.ready();
  const cwd = E2B_PROJECT_DIR;

  const status = await runInSandbox(e2b, "git status --porcelain", { cwd });
  if (!status.stdout.trim()) return { pushed: false, detail: "Nothing to push — no changes in the workspace." };

  // -c rather than `git config`, so the identity applies to this commit instead of being
  // written into the repository the user will get back.
  const commit = await runInSandbox(
    e2b,
    `git add -A && git -c user.name='Deep Agents IDE' -c user.email='noreply@deepagents.local' commit -m ${shellQuote(message)}`,
    { cwd }
  );
  if (commit.exitCode !== 0) {
    return { pushed: false, detail: `Commit failed in the sandbox: ${scrub(commit.stderr || commit.stdout, githubToken)}` };
  }

  const branch = (await runInSandbox(e2b, "git rev-parse --abbrev-ref HEAD", { cwd })).stdout.trim();
  const push = await runInSandbox(e2b, `git ${credentialArgs(githubToken)}push origin ${shellQuote(branch)}`, {
    cwd,
    envs: gitEnv(githubToken),
  });

  return push.exitCode === 0
    ? { pushed: true, detail: `Pushed to ${branch}.` }
    : { pushed: false, detail: `Committed in the sandbox, but push failed: ${scrub(push.stderr || push.stdout, githubToken)}` };
}

/**
 * Wraps a value so a shell treats it as one literal argument.
 *
 * The repository URL and branch come from whatever the user typed into the workspace
 * picker, and these strings are handed to a real shell inside the sandbox — unquoted, a
 * repo "URL" containing `;` or a backtick would run as a second command.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Feeds git the token through a credential helper reading an environment variable, so it
 * appears neither in the command line (readable via `ps` inside the sandbox) nor in
 * `.git/config` afterwards. Only `$GH_TOKEN` — the literal name — is in the command string.
 */
function credentialArgs(githubToken?: string): string {
  if (!githubToken) return "";
  return `-c credential.helper='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' `;
}

function gitEnv(githubToken?: string): Record<string, string> {
  // GIT_TERMINAL_PROMPT stops a private repo without a usable token from hanging forever on
  // a username prompt no one can answer.
  return githubToken ? { GH_TOKEN: githubToken, GIT_TERMINAL_PROMPT: "0" } : { GIT_TERMINAL_PROMPT: "0" };
}

function scrub(text: string, githubToken?: string): string {
  return githubToken ? text.split(githubToken).join("***") : text;
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
