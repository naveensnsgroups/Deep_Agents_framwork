import { E2BSandbox } from "./e2bSandbox.js";

/**
 * Where a cloned repository lives inside the sandbox. E2B's base template runs as the
 * `user` account, so this sits in its home directory rather than somewhere needing sudo.
 */
export const E2B_PROJECT_DIR = "/home/user/project";

/**
 * Whether agent work runs in an E2B microVM rather than on this server.
 *
 * Opt-in rather than automatic because local development happens on Windows against a real
 * folder on the developer's own disk — the whole point there is to operate on files you can
 * see — while a deployment wants the opposite. `E2B_API_KEY` alone isn't the switch: having
 * a key configured shouldn't silently change where a local run executes.
 *
 * Read on each call rather than captured in a module constant. ESM hoists every `import`
 * above the importing module's own statements, so server.ts's `dotenv.config()` runs *after*
 * this file has been evaluated — a constant here reads the variable before `.env` is loaded
 * and silently leaves the sandbox switched off.
 */
export function isE2BEnabled(): boolean {
  return process.env.SANDBOX_PROVIDER?.trim().toLowerCase() === "e2b";
}

/**
 * Live sandboxes, keyed by E2B's own sandbox id.
 *
 * A workspace's "root" is normally a directory path, and the REST file routes, the terminal
 * and the git helpers all take one. In sandbox mode there is no such path on this machine,
 * so the root becomes the opaque string `e2b://<sandboxId>` and those same call sites
 * resolve it through here. That keeps one notion of "which workspace" flowing through the
 * app instead of threading a second sandbox parameter into every route.
 */
const sessions = new Map<string, E2BSandbox>();

export function isE2BRoot(root: string): boolean {
  return root.startsWith("e2b://");
}

export function rootForSandboxId(sandboxId: string): string {
  return `e2b://${sandboxId}`;
}

function sandboxIdFromRoot(root: string): string {
  return root.slice("e2b://".length);
}

/** Boots a sandbox and registers it, returning the root string the client will use. */
export async function createSandboxSession(): Promise<{ sandbox: E2BSandbox; root: string }> {
  // Commands start in the cloned repository, not the sandbox user's home — otherwise a
  // build or test command runs one directory above the project and reports success on an
  // empty directory.
  const sandbox = new E2BSandbox({ cwd: E2B_PROJECT_DIR });
  await sandbox.ready();

  const id = sandbox.sandboxId;
  if (!id) throw new Error("E2B sandbox started but reported no id");

  sessions.set(id, sandbox);
  return { sandbox, root: rootForSandboxId(id) };
}

export function sandboxForRoot(root: string): E2BSandbox | undefined {
  return isE2BRoot(root) ? sessions.get(sandboxIdFromRoot(root)) : undefined;
}

/**
 * Ends the billed session and forgets it. Called when a workspace is replaced or its
 * connection closes — E2B would otherwise keep charging until the idle timeout expires.
 */
export async function closeSandboxSession(root: string): Promise<void> {
  if (!isE2BRoot(root)) return;
  const id = sandboxIdFromRoot(root);
  const sandbox = sessions.get(id);
  sessions.delete(id);
  await sandbox?.close();
}
