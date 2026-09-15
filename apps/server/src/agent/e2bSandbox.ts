import { CommandExitError, Sandbox } from "e2b";
import { BaseSandbox, type ExecuteResponse, type FileDownloadResponse, type FileUploadResponse } from "deepagents";

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
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

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

  constructor(private readonly options: E2BSandboxOptions = {}) {
    super();
  }

  private ensure(): Promise<Sandbox> {
    this.booting ??= Sandbox.create(this.options.template ?? "base", {
      apiKey: this.options.apiKey ?? process.env.E2B_API_KEY,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      // `denyOut: allTraffic` with an `allowOut` list is E2B's documented way to express a
      // default-deny egress policy; without `denyOut` the allow list is additive and
      // everything else still gets out.
      network: {
        allowOut: this.options.egressAllowlist ?? EGRESS_ALLOWLIST,
        denyOut: ({ allTraffic }) => [allTraffic],
      },
    }).then((sandbox) => {
      this.sandbox = sandbox;
      return sandbox;
    });
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

  /** Pushes the idle deadline out so a long migration isn't reclaimed mid-run. */
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
          await sandbox.files.write(path, content.slice().buffer as ArrayBuffer);
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
          const content = await sandbox.files.read(path, { format: "bytes" });
          return { path, content, error: null };
        } catch (err) {
          return { path, content: null, error: downloadErrorCode(err) };
        }
      })
    );
  }

  /** Ends the billed session. Nothing else reclaims it before the idle timeout. */
  async close(): Promise<void> {
    const sandbox = this.sandbox;
    this.sandbox = undefined;
    this.booting = undefined;
    await sandbox?.kill().catch(() => {
      // Already gone (timed out, or killed elsewhere) — nothing left to release.
    });
  }
}

/**
 * E2B reports these as message text rather than typed errors for filesystem operations, so
 * the mapping to the protocol's codes is by inspection. Anything unrecognized becomes
 * "invalid_path", which is the protocol's least specific failure rather than a wrong claim
 * about permissions.
 */
function classify(err: unknown): "file_not_found" | "permission_denied" | "is_directory" | "invalid_path" {
  const message = (err as Error)?.message?.toLowerCase() ?? "";
  if (message.includes("not found") || message.includes("no such file")) return "file_not_found";
  if (message.includes("permission denied")) return "permission_denied";
  if (message.includes("is a directory")) return "is_directory";
  return "invalid_path";
}

const uploadErrorCode = classify;
const downloadErrorCode = classify;
