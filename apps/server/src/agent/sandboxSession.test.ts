import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { E2BSandbox } from "./e2bSandbox.js";
import {
  acquireSandbox,
  detachAllSandboxSessions,
  memoryRecords,
  releaseSandbox,
  sandboxForRoot,
  sandboxTestHooks,
  type SandboxRecords,
} from "./sandboxSession.js";

interface FakeSandbox {
  options: { sandboxId?: string };
  sandboxId?: string;
  closed: boolean;
  detachedFor?: number;
  hasProject: boolean;
}

let created: FakeSandbox[];
let nextId: number;
/** Ids of sandboxes that still exist on "E2B", and whether each has a cloned project. */
let remote: Map<string, { hasProject: boolean }>;
let records: SandboxRecords;

function fakeFactory(options: { sandboxId?: string }) {
  const fake: FakeSandbox & Record<string, unknown> = {
    options,
    closed: false,
    hasProject: false,
    async ready() {
      if (options.sandboxId) {
        const existing = remote.get(options.sandboxId);
        if (!existing) throw new Error("sandbox not found");
        fake.sandboxId = options.sandboxId;
        fake.hasProject = existing.hasProject;
      } else if (!fake.sandboxId) {
        fake.sandboxId = `sbx-${nextId++}`;
        remote.set(fake.sandboxId, { hasProject: false });
      }
      return {
        commands: {
          run: async () => ({ exitCode: remote.get(fake.sandboxId!)?.hasProject ? 0 : 1 }),
        },
      };
    },
    async close() {
      fake.closed = true;
      if (fake.sandboxId) remote.delete(fake.sandboxId);
    },
    async detach(ms: number) {
      fake.detachedFor = ms;
    },
  };
  created.push(fake);
  return fake as unknown as E2BSandbox;
}

async function clone(sandbox: E2BSandbox) {
  const fake = sandbox as unknown as FakeSandbox;
  remote.set(fake.sandboxId!, { hasProject: true });
}

beforeEach(() => {
  created = [];
  nextId = 1;
  remote = new Map();
  records = memoryRecords();
  sandboxTestHooks.reset();
  sandboxTestHooks.useRecords(records);
  sandboxTestHooks.createSandbox = fakeFactory as never;
});
afterEach(() => {
  vi.useRealTimers();
  sandboxTestHooks.reset();
});

const alice = { owner: "gh:1", projectKey: "https://github.com/a/repo", prepare: clone };

describe("sandbox sessions", () => {
  it("creates and clones once, then reuses the running sandbox for the same user and project", async () => {
    const prepare = vi.fn(clone);
    const first = await acquireSandbox({ ...alice, prepare });
    expect(first.reused).toBe(false);
    expect(prepare).toHaveBeenCalledTimes(1);

    const second = await acquireSandbox({ ...alice, prepare });
    expect(second.reused).toBe(true);
    expect(second.root).toBe(first.root);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("gives another user their own sandbox for the same repository", async () => {
    const a = await acquireSandbox(alice);
    const b = await acquireSandbox({ ...alice, owner: "gh:2" });
    expect(b.root).not.toBe(a.root);
  });

  // A root is a string the client sends back; another user's must resolve to nothing.
  it("only resolves a root for its owner", async () => {
    const { root } = await acquireSandbox(alice);
    expect(sandboxForRoot(root, "gh:1")).toBeDefined();
    expect(sandboxForRoot(root, "gh:2")).toBeUndefined();
  });

  it("keeps a released sandbox for the grace period, and reconnecting within it cancels the kill", async () => {
    vi.useFakeTimers();
    const { root } = await acquireSandbox(alice);
    releaseSandbox(root, 1000);

    await vi.advanceTimersByTimeAsync(500);
    const again = await acquireSandbox(alice);
    expect(again.root).toBe(root);

    await vi.advanceTimersByTimeAsync(5000);
    expect(created[0].closed).toBe(false);
  });

  it("kills the sandbox once the grace period passes with nobody using it", async () => {
    vi.useFakeTimers();
    const { root } = await acquireSandbox(alice);
    releaseSandbox(root, 1000);
    await vi.advanceTimersByTimeAsync(1500);

    expect(created[0].closed).toBe(true);
    expect(sandboxForRoot(root, "gh:1")).toBeUndefined();
    expect(await records.get(`gh:1\n${alice.projectKey}`)).toBeUndefined();
  });

  // Two tabs on one project: closing one must not kill the sandbox under the other.
  it("does not start the grace period while another connection still uses it", async () => {
    vi.useFakeTimers();
    const { root } = await acquireSandbox(alice);
    await acquireSandbox(alice);

    releaseSandbox(root, 1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(created[0].closed).toBe(false);
  });

  it("reconnects to the sandbox a previous server process left running", async () => {
    const first = await acquireSandbox(alice);
    await detachAllSandboxSessions(600_000);
    expect(created[0].detachedFor).toBe(600_000);
    expect(created[0].closed).toBe(false);

    // A new process: nothing in memory, only the stored record.
    const prepare = vi.fn(clone);
    const second = await acquireSandbox({ ...alice, prepare });
    expect(second.root).toBe(first.root);
    expect(second.reused).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
  });

  it("falls back to a fresh sandbox when the recorded one is gone", async () => {
    await records.set(`gh:1\n${alice.projectKey}`, "sbx-expired");
    const prepare = vi.fn(clone);
    const acquired = await acquireSandbox({ ...alice, prepare });
    expect(acquired.reused).toBe(false);
    expect(acquired.root).not.toBe("e2b://sbx-expired");
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("closes a new sandbox whose clone fails, and remembers nothing", async () => {
    await expect(
      acquireSandbox({ ...alice, prepare: async () => Promise.reject(new Error("clone failed")) })
    ).rejects.toThrow("clone failed");
    expect(created[0].closed).toBe(true);
    expect(await records.get(`gh:1\n${alice.projectKey}`)).toBeUndefined();
  });

  it("shares one boot between two opens that arrive at the same time", async () => {
    const prepare = vi.fn(clone);
    const [a, b] = await Promise.all([acquireSandbox({ ...alice, prepare }), acquireSandbox({ ...alice, prepare })]);
    expect(a.root).toBe(b.root);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
