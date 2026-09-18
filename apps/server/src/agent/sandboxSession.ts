import type { Collection } from "mongodb";
import { E2BSandbox } from "./e2bSandbox.js";
import { getPersistence } from "./persistence.js";

/**
 * Where a cloned repository lives inside the sandbox. E2B's base template runs as the
 * `user` account, so this sits in its home directory rather than somewhere needing sudo.
 */
export const E2B_PROJECT_DIR = "/home/user/project";

/**
 * How long a sandbox outlives the last browser tab using it. Long enough that a reload, a short
 * break or a redeploy of this server lands back in the same sandbox with the agent's edits still
 * there; short enough that an abandoned one stops billing soon.
 */
export const SANDBOX_GRACE_MS = 10 * 60 * 1000;

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
 * A live sandbox and who may use it.
 *
 * A workspace's "root" is normally a directory path, and the REST file routes, the terminal
 * and the git helpers all take one. In sandbox mode there is no such path on this machine,
 * so the root becomes the opaque string `e2b://<sandboxId>` and those same call sites
 * resolve it through here. That keeps one notion of "which workspace" flowing through the
 * app instead of threading a second sandbox parameter into every route.
 */
interface Entry {
  sandbox: E2BSandbox;
  owner: string;
  projectKey: string;
  /** Open connections using it. It is only scheduled for release once this reaches zero. */
  refs: number;
  releaseTimer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, Entry>();

/** Concurrent opens of the same project (two tabs at once) share one boot instead of racing. */
const inflight = new Map<string, Promise<Acquired>>();

export function isE2BRoot(root: string): boolean {
  return root.startsWith("e2b://");
}

export function rootForSandboxId(sandboxId: string): string {
  return `e2b://${sandboxId}`;
}

function sandboxIdFromRoot(root: string): string {
  return root.slice("e2b://".length);
}

function slotKey(owner: string, projectKey: string): string {
  return `${owner}\n${projectKey}`;
}

// ---------------------------------------------------------------------------------------------
// Which sandbox each user's project last had, so a new server process can reconnect to it.

interface SandboxRecord {
  _id: string;
  sandboxId: string;
  updatedAt: Date;
}

export interface SandboxRecords {
  get(key: string): Promise<string | undefined>;
  set(key: string, sandboxId: string): Promise<void>;
  remove(key: string, sandboxId: string): Promise<void>;
}

function mongoRecords(collection: Collection<SandboxRecord>): SandboxRecords {
  // Records outlive their sandbox only briefly; the index keeps crashed-process leftovers from piling up.
  void collection.createIndex({ updatedAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 }).catch(() => undefined);
  return {
    get: async (key) => (await collection.findOne({ _id: key }))?.sandboxId,
    async set(key, sandboxId) {
      await collection.updateOne({ _id: key }, { $set: { sandboxId, updatedAt: new Date() } }, { upsert: true });
    },
    async remove(key, sandboxId) {
      // Only if it still points at this sandbox — a newer one may have replaced it meanwhile.
      await collection.deleteOne({ _id: key, sandboxId });
    },
  };
}

/** Without MongoDB, reconnect only works within this process, which the in-memory map already covers. */
export function memoryRecords(): SandboxRecords {
  const map = new Map<string, string>();
  return {
    get: async (key) => map.get(key),
    set: async (key, id) => void map.set(key, id),
    remove: async (key, id) => {
      if (map.get(key) === id) map.delete(key);
    },
  };
}

let records: Promise<SandboxRecords> | undefined;

function getRecords(): Promise<SandboxRecords> {
  records ??= getPersistence()
    .then(({ db }) => (db ? mongoRecords(db.collection<SandboxRecord>("sandboxes")) : memoryRecords()))
    .catch(() => memoryRecords());
  return records;
}

/** Test seams. */
export const sandboxTestHooks = {
  useRecords(next: SandboxRecords | undefined) {
    records = next ? Promise.resolve(next) : undefined;
  },
  createSandbox: (options: ConstructorParameters<typeof E2BSandbox>[0]) => new E2BSandbox(options),
  reset() {
    for (const entry of sessions.values()) clearTimeout(entry.releaseTimer);
    sessions.clear();
    inflight.clear();
  },
};

// ---------------------------------------------------------------------------------------------

export interface Acquired {
  sandbox: E2BSandbox;
  root: string;
  /** True when this is an existing sandbox with the project already in it — skip the clone. */
  reused: boolean;
}

export interface AcquireOptions {
  /** Whose sandbox this is. */
  owner: string;
  /** Identifies the project within the owner's sandboxes — the normalized repo URL. */
  projectKey: string;
  /** Fills a brand-new sandbox, typically by cloning the repository. Not called on reuse. */
  prepare(sandbox: E2BSandbox): Promise<void>;
}

/**
 * The sandbox for this user's project: the one already running in this process, else the one a
 * previous server process left running (found through the stored record), else a new one.
 *
 * Every successful call must be balanced by `releaseSandbox` when that connection is done.
 */
export function acquireSandbox(options: AcquireOptions): Promise<Acquired> {
  const key = slotKey(options.owner, options.projectKey);
  const pending = inflight.get(key);
  if (pending) {
    return pending.then((acquired) => {
      const entry = sessions.get(sandboxIdFromRoot(acquired.root));
      if (entry) entry.refs++;
      return { ...acquired, reused: true };
    });
  }

  const attempt = acquireUncached(options, key).finally(() => inflight.delete(key));
  inflight.set(key, attempt);
  return attempt;
}

async function acquireUncached({ owner, projectKey, prepare }: AcquireOptions, key: string): Promise<Acquired> {
  // 1. Still running in this process — typically a reload within the grace period.
  for (const [id, entry] of sessions) {
    if (entry.owner === owner && entry.projectKey === projectKey) {
      clearTimeout(entry.releaseTimer);
      entry.releaseTimer = undefined;
      entry.refs++;
      return { sandbox: entry.sandbox, root: rootForSandboxId(id), reused: true };
    }
  }

  const store = await getRecords();

  // 2. Left running by an earlier process — typically this server was redeployed.
  const previousId = await store.get(key).catch(() => undefined);
  if (previousId) {
    const sandbox = sandboxTestHooks.createSandbox({ cwd: E2B_PROJECT_DIR, sandboxId: previousId });
    try {
      const e2b = await sandbox.ready();
      // A sandbox whose clone never finished is no use to reconnect to.
      const check = await e2b.commands.run(`test -d ${E2B_PROJECT_DIR}/.git`);
      if (check.exitCode !== 0) throw new Error("project missing");
      register(previousId, sandbox, owner, projectKey);
      return { sandbox, root: rootForSandboxId(previousId), reused: true };
    } catch {
      // Expired or unusable: kill it in case it still runs, and fall through to a fresh one.
      await sandbox.close();
      await store.remove(key, previousId).catch(() => undefined);
    }
  }

  // 3. A new sandbox.
  // Commands start in the cloned repository, not the sandbox user's home — otherwise a
  // build or test command runs one directory above the project and reports success on an
  // empty directory.
  const sandbox = sandboxTestHooks.createSandbox({ cwd: E2B_PROJECT_DIR });
  let id: string | undefined;
  try {
    await sandbox.ready();
    id = sandbox.sandboxId;
    if (!id) throw new Error("E2B sandbox started but reported no id");
    await prepare(sandbox);
  } catch (err) {
    // Not registered anywhere yet, so nothing else would ever close it.
    await sandbox.close();
    throw err;
  }

  register(id, sandbox, owner, projectKey);
  await store.set(key, id).catch(() => undefined);
  return { sandbox, root: rootForSandboxId(id), reused: false };
}

function register(id: string, sandbox: E2BSandbox, owner: string, projectKey: string): void {
  sessions.set(id, { sandbox, owner, projectKey, refs: 1 });
}

/**
 * The sandbox behind a workspace root, but only for its owner — a root is just a string the
 * client sends back, so another user's `e2b://<id>` must resolve to nothing.
 */
export function sandboxForRoot(root: string, owner: string): E2BSandbox | undefined {
  if (!isE2BRoot(root)) return undefined;
  const entry = sessions.get(sandboxIdFromRoot(root));
  return entry && entry.owner === owner ? entry.sandbox : undefined;
}

/**
 * One connection is done with this sandbox. When no connection is left it stays alive for
 * SANDBOX_GRACE_MS, then is killed — E2B bills per running second, so nothing should wait for
 * E2B's own timeout.
 */
export function releaseSandbox(root: string, graceMs = SANDBOX_GRACE_MS): void {
  if (!isE2BRoot(root)) return;
  const id = sandboxIdFromRoot(root);
  const entry = sessions.get(id);
  if (!entry) return;

  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0 || entry.releaseTimer) return;

  entry.releaseTimer = setTimeout(() => void killSandbox(id), graceMs);
  entry.releaseTimer.unref();
}

async function killSandbox(id: string): Promise<void> {
  const entry = sessions.get(id);
  if (!entry || entry.refs > 0) return;
  sessions.delete(id);
  await entry.sandbox.close();
  const store = await getRecords();
  await store.remove(slotKey(entry.owner, entry.projectKey), id).catch(() => undefined);
}

/**
 * On shutdown, sandboxes are detached rather than killed: each is left SANDBOX_GRACE_MS to live
 * and its record kept, so users reconnecting to the next server process — after a deploy — pick
 * up where they were. Anything nobody reconnects to is reclaimed by E2B when that time runs out.
 */
export async function detachAllSandboxSessions(remainingMs = SANDBOX_GRACE_MS): Promise<void> {
  const entries = [...sessions.values()];
  sessions.clear();
  await Promise.all(
    entries.map((entry) => {
      clearTimeout(entry.releaseTimer);
      return entry.sandbox.detach(remainingMs);
    })
  );
}
