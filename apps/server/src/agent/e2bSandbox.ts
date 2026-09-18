import { CommandExitError, NotFoundError, Sandbox } from "e2b";
import {
  BaseSandbox,
  type DeleteResult,
  type EditResult,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileUploadResponse,
  type GlobResult,
  type GrepResult,
  type LsResult,
  type ReadRawResult,
  type ReadResult,
  type WriteResult,
} from "deepagents";

/**
 * The agent addresses files the way it does everywhere else in this app — `/src/app.js`,
 * `/migrated/**`, `./.deepagents/AGENTS.md` — with `/` meaning the project root. BaseSandbox
 * instead treats every path as absolute on the microVM's own filesystem, where the clone lives
 * at `root` (e.g. /home/user/project). Unmapped, `/src/app.js` pointed at the VM's filesystem
 * root and a relative path at the user's home, so the agent could not see or edit the repo.
 */
export function toSandboxPath(root: string | undefined, virtualPath: string): string {
  if (!root) return virtualPath;
  if (virtualPath === root || virtualPath.startsWith(`${root}/`)) return virtualPath;
  let rel = virtualPath;
  if (rel === "." || rel === "./") rel = "";
  else if (rel.startsWith("./")) rel = rel.slice(2);
  rel = rel.replace(/^\/+/, "");
  return rel ? `${root}/${rel}` : root;
}

/** Reverses toSandboxPath, so results carry the same paths permissions and approvals match on. */
export function fromSandboxPath(root: string | undefined, sandboxPath: string): string {
  if (!root) return sandboxPath;
  if (sandboxPath === root) return "/";
  return sandboxPath.startsWith(`${root}/`) ? sandboxPath.slice(root.length) : sandboxPath;
}

/**
 * Runs the agent's shell commands and file operations inside an E2B microVM instead of on
 * this server.
 *
 * deepagents' own docs say `LocalShellBackend` — what this replaces — is for "dedicated
 * development environments" and never production systems, because `execute` runs arbitrary
 * commands with the server process's own privileges. On a cloud host that means a migration
 * run, or a prompt injected through the source code it is reading, has the whole instance.
 *
 * There is no `@langchain/e2b` for JavaScript (it exists only for Python), so this is the
 * adapter. It stays small because `BaseSandbox` implements `ls`, `read`, `readRaw`, `glob`,
 * `grep`, `write`, `edit` and `delete` on top of `execute` using plain POSIX shell — the
 * only members a concrete sandbox must supply are the four below.
 */
export interface E2BSandboxOptions {
  /** E2B template to boot. "base" is their general-purpose image. */
  template?: string;
  /** Idle lifetime before E2B reclaims the sandbox. Billing is per running hour. */
  timeoutMs?: number;
  apiKey?: string;
  /**
   * Directory every command starts in. Without it E2B runs commands in the user's home,
   * so `npm test` or `pytest` would execute one level above the cloned repository and find
   * nothing — the agent would be told its build passed because there was nothing to build.
   */
  cwd?: string;
  /** Overrides EGRESS_ALLOWLIST. An empty array blocks all outbound traffic. */
  egressAllowlist?: string[];
  /**
   * Reattach to this already-running sandbox instead of booting a new one. Its network policy
   * and files are whatever it was created with; only the lifetime is refreshed.
   */
  sandboxId?: string;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const KEEP_ALIVE_EVERY_MS = 5 * 60 * 1000;

/**
 * Hosts the sandbox may reach. Everything else is refused.
 *
 * Without this, E2B allows all outbound traffic — so an injected instruction that gets past
 * the approval gate can still POST the repository somewhere. The microVM protects *this
 * server*; it does nothing about exfiltration until egress is bounded.
 *
 * The list is what a migration genuinely needs: the git remote, and the package registries a
 * build or test run resolves from. Anything absent from it is a deliberate decision, not an
 * oversight — if a real migration turns out to need another host, add it here rather than
 * widening the rule, so the list stays a readable statement of what the agent is allowed to
 * talk to.
 */
const EGRESS_ALLOWLIST = [
  // git
  "github.com",
  "*.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  // npm
  "registry.npmjs.org",
  "*.npmjs.org",
  // python
  "pypi.org",
  "files.pythonhosted.org",
  // debian/ubuntu packages, for a template that installs system dependencies
  "deb.debian.org",
  "security.debian.org",
];

export class E2BSandbox extends BaseSandbox {
  readonly id = "e2b";

  private sandbox?: Sandbox;
  /** Memoized so concurrent tool calls during one turn share a single boot, not one each. */
  private booting?: Promise<Sandbox>;
  /**
   * E2B's `timeoutMs` is a kill deadline fixed at creation, not an idle timer — activity does
   * not extend it, only `setTimeout` does. Without this, every sandbox died a fixed 15 minutes
   * after its workspace opened, mid-migration or not. If this process dies the refresh stops
   * with it, so an orphaned sandbox is still reclaimed within one timeout.
   */
  private refresher?: ReturnType<typeof setInterval>;

  constructor(private readonly options: E2BSandboxOptions = {}) {
    super();
  }

  private ensure(): Promise<Sandbox> {
    const apiKey = this.options.apiKey ?? process.env.E2B_API_KEY;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    this.booting ??= (
      this.options.sandboxId
        ? // connect only ever lengthens a running sandbox's deadline, so it is set explicitly
          // afterwards — a sandbox left with seconds to live would otherwise die mid-reconnect.
          Sandbox.connect(this.options.sandboxId, { apiKey, timeoutMs }).then(async (sandbox) => {
            await sandbox.setTimeout(timeoutMs);
            return sandbox;
          })
        : Sandbox.create(this.options.template ?? "base", {
            apiKey,
            timeoutMs,
            // `denyOut: allTraffic` with an `allowOut` list is E2B's documented way to express a
            // default-deny egress policy; without `denyOut` the allow list is additive and
            // everything else still gets out.
            network: {
              allowOut: this.options.egressAllowlist ?? EGRESS_ALLOWLIST,
              denyOut: ({ allTraffic }) => [allTraffic],
            },
          })
    ).then((sandbox) => {
      this.sandbox = sandbox;
      this.refresher = setInterval(() => void this.keepAlive(), Math.min(KEEP_ALIVE_EVERY_MS, timeoutMs / 3));
      this.refresher.unref();
      return sandbox;
    });
    // A failed boot or reconnect must not be cached, or every later call would reuse the error.
    this.booting.catch(() => (this.booting = undefined));
    return this.booting;
  }

  /**
   * The live E2B handle, booting it if this is the first use.
   *
   * The agent only ever needs the protocol methods, but the REST file routes, the terminal
   * and the git clone all have to reach the same sandbox this agent is working in —
   * otherwise the file tree shows an empty directory and the terminal opens a shell on a
   * different machine than the one the agent is editing.
   */
  ready(): Promise<Sandbox> {
    return this.ensure();
  }

  /** Undefined until the first `ready()` resolves. */
  get sandboxId(): string | undefined {
    return this.sandbox?.sandboxId;
  }

  /** Moves the kill deadline to `timeoutMs` from now. Called on an interval once booted. */
  async keepAlive(timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS): Promise<void> {
    await this.sandbox?.setTimeout(timeoutMs).catch(() => {
      // Sandbox already gone; the next operation will surface it more usefully than this.
    });
  }

  /**
   * A failing command is an expected, informative outcome here — the verifier subagent's
   * entire job is to run a build or test suite and report what broke — so `CommandExitError`
   * is unwrapped into a normal response carrying the real exit code and output rather than
   * propagating as an exception the agent would only see as a tool crash.
   */
  async execute(command: string): Promise<ExecuteResponse> {
    const sandbox = await this.ensure();
    const opts = this.options.cwd ? { cwd: this.options.cwd } : undefined;
    try {
      const result = await sandbox.commands.run(command, opts);
      return { output: `${result.stdout}${result.stderr}`, exitCode: result.exitCode, truncated: false };
    } catch (err) {
      if (err instanceof CommandExitError) {
        return { output: `${err.stdout}${err.stderr}`, exitCode: err.exitCode, truncated: false };
      }
      // A transport or lifecycle failure (sandbox reclaimed, network gone) is genuinely not
      // a command result, so it is reported as one with a null exit code rather than being
      // disguised as the command having failed.
      return { output: `Sandbox error: ${(err as Error).message}`, exitCode: null, truncated: false };
    }
  }

  /** Per-file try/catch because the protocol requires partial success, not all-or-nothing. */
  async uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    const sandbox = await this.ensure();
    return Promise.all(
      files.map(async ([path, content]): Promise<FileUploadResponse> => {
        try {
          // Copied into a fresh ArrayBuffer: a Uint8Array may be a view onto a larger
          // pooled buffer, and passing `.buffer` straight through would upload the whole
          // pool rather than this file's bytes.
          await sandbox.files.write(this.toSandbox(path), content.slice().buffer as ArrayBuffer);
          return { path, error: null };
        } catch (err) {
          return { path, error: uploadErrorCode(err) };
        }
      })
    );
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const sandbox = await this.ensure();
    return Promise.all(
      paths.map(async (path): Promise<FileDownloadResponse> => {
        try {
          const content = await sandbox.files.read(this.toSandbox(path), { format: "bytes" });
          return { path, content, error: null };
        } catch (err) {
          return { path, content: null, error: downloadErrorCode(err) };
        }
      })
    );
  }

  override async ls(path: string): Promise<LsResult> {
    return this.unmap(await super.ls(this.toSandbox(path)));
  }

  override async read(filePath: string, offset?: number, limit?: number): Promise<ReadResult> {
    return this.unmap(await super.read(this.toSandbox(filePath), offset, limit));
  }

  override async readRaw(filePath: string): Promise<ReadRawResult> {
    return this.unmap(await super.readRaw(this.toSandbox(filePath)));
  }

  override async grep(pattern: string, path = "/", glob?: string | null, maxCount?: number | null): Promise<GrepResult> {
    return this.unmap(await super.grep(pattern, this.toSandbox(path), glob, maxCount));
  }

  override async glob(pattern: string, path = "/"): Promise<GlobResult> {
    return this.unmap(await super.glob(pattern, this.toSandbox(path)));
  }

  override async write(filePath: string, content: string): Promise<WriteResult> {
    return this.unmap(await super.write(this.toSandbox(filePath), content));
  }

  override async delete(filePath: string): Promise<DeleteResult> {
    return this.unmap(await super.delete(this.toSandbox(filePath)));
  }

  override async edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<EditResult> {
    return this.unmap(await super.edit(this.toSandbox(filePath), oldString, newString, replaceAll));
  }

  private toSandbox(path: string): string {
    return toSandboxPath(this.options.cwd, path);
  }

  /** Rewrites every path a result carries — including inside error text — back to project-relative form. */
  private unmap<T>(result: T): T {
    const root = this.options.cwd;
    if (!root) return result;
    const r = result as { error?: string; path?: string; files?: Array<{ path: string }>; matches?: Array<{ path: string }> };
    if (typeof r.error === "string") r.error = r.error.split(`${root}/`).join("/");
    if (typeof r.path === "string") r.path = fromSandboxPath(root, r.path);
    r.files?.forEach((f) => (f.path = fromSandboxPath(root, f.path)));
    r.matches?.forEach((m) => (m.path = fromSandboxPath(root, m.path)));
    return result;
  }

  /**
   * Lets go of the sandbox without killing it: stops refreshing its lifetime and leaves it
   * `remainingMs` to live. Used on server shutdown so a user whose tab reconnects to the next
   * server process gets their sandbox back; if nobody does, E2B reclaims it when that runs out.
   */
  async detach(remainingMs: number): Promise<void> {
    clearInterval(this.refresher);
    this.refresher = undefined;
    const sandbox = this.sandbox;
    this.sandbox = undefined;
    this.booting = undefined;
    await sandbox?.setTimeout(remainingMs).catch(() => {
      // Already gone — nothing to leave running.
    });
  }

  /** Ends the billed session. Nothing else reclaims it before the idle timeout. */
  async close(): Promise<void> {
    clearInterval(this.refresher);
    this.refresher = undefined;
    const sandbox = this.sandbox;
    this.sandbox = undefined;
    this.booting = undefined;
    await sandbox?.kill().catch(() => {
      // Already gone (timed out, or killed elsewhere) — nothing left to release.
    });
  }
}

/**
 * A missing file arrives as E2B's typed FileNotFoundError (a NotFoundError), whose message does
 * not necessarily say "not found" — matching on text alone misreported it as "invalid_path",
 * which callers treat as a real failure instead of an absent optional file. Other conditions
 * are still only distinguishable by message. Anything unrecognized becomes "invalid_path", the
 * protocol's least specific failure rather than a wrong claim about permissions.
 */
function classify(err: unknown): "file_not_found" | "permission_denied" | "is_directory" | "invalid_path" {
  if (err instanceof NotFoundError) return "file_not_found";
  const message = (err as Error)?.message?.toLowerCase() ?? "";
  if (message.includes("not found") || message.includes("no such file")) return "file_not_found";
  if (message.includes("permission denied")) return "permission_denied";
  if (message.includes("is a directory")) return "is_directory";
  return "invalid_path";
}

const uploadErrorCode = classify;
const downloadErrorCode = classify;
