import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fakeSandbox, NotFoundError, CommandExitError } = vi.hoisted(() => {
  class NotFoundError extends Error {}
  // Shaped like the SDK's: the failed command's result travels on the error.
  class CommandExitError extends Error {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    constructor(result: { exitCode: number; stdout: string; stderr: string }) {
      super(`exit status ${result.exitCode}`);
      this.exitCode = result.exitCode;
      this.stdout = result.stdout;
      this.stderr = result.stderr;
    }
  }
  return {
    NotFoundError,
    CommandExitError,
    fakeSandbox: {
      sandboxId: "sbx-test",
      setTimeout: vi.fn(async () => {}),
      kill: vi.fn(async () => {}),
      commands: { run: vi.fn(async (_cmd: string, _opts?: unknown) => ({ stdout: "", stderr: "", exitCode: 0 })) },
      files: {
        write: vi.fn(async (_path: string, _data: unknown) => {}),
        read: vi.fn(async (_path: string, _opts?: unknown): Promise<unknown> => new TextEncoder().encode("contents")),
      },
    },
  };
});

vi.mock("e2b", () => ({
  Sandbox: { create: vi.fn(async () => fakeSandbox) },
  CommandExitError,
  NotFoundError,
}));

const { E2BSandbox, toSandboxPath, fromSandboxPath, runInSandbox } = await import("./e2bSandbox.js");

const ROOT = "/home/user/project";

describe("E2BSandbox keep-alive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeSandbox.setTimeout.mockClear();
    fakeSandbox.kill.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  // The creation timeout is a hard kill deadline; if nothing extends it, a long migration's
  // sandbox is destroyed underneath it at a fixed time after boot.
  it("keeps extending the kill deadline while the sandbox is open", async () => {
    const sandbox = new E2BSandbox();
    await sandbox.ready();

    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

    expect(fakeSandbox.setTimeout).toHaveBeenCalledTimes(4);
    expect(fakeSandbox.setTimeout).toHaveBeenLastCalledWith(15 * 60 * 1000);
  });

  it("stops extending once closed, so the sandbox can actually expire", async () => {
    const sandbox = new E2BSandbox();
    await sandbox.ready();
    await sandbox.close();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(fakeSandbox.setTimeout).not.toHaveBeenCalled();
    expect(fakeSandbox.kill).toHaveBeenCalledOnce();
  });
});

describe("project path mapping", () => {
  it.each([
    ["/", ROOT],
    ["/src/app.js", `${ROOT}/src/app.js`],
    ["/src/", `${ROOT}/src/`],
    ["./.deepagents/AGENTS.md", `${ROOT}/.deepagents/AGENTS.md`],
    [".deepagents/AGENTS.md", `${ROOT}/.deepagents/AGENTS.md`],
    [`${ROOT}/src/app.js`, `${ROOT}/src/app.js`],
  ])("maps %s into the project", (virtualPath, expected) => {
    expect(toSandboxPath(ROOT, virtualPath)).toBe(expected);
  });

  it.each([
    [ROOT, "/"],
    [`${ROOT}/src/app.js`, "/src/app.js"],
    ["/etc/hosts", "/etc/hosts"],
  ])("maps %s back to %s", (sandboxPath, expected) => {
    expect(fromSandboxPath(ROOT, sandboxPath)).toBe(expected);
  });

  it("leaves paths untouched when no project directory is configured", () => {
    expect(toSandboxPath(undefined, "/src/app.js")).toBe("/src/app.js");
  });
});

describe("E2BSandbox file operations inside the project", () => {
  beforeEach(() => {
    fakeSandbox.commands.run.mockClear();
    fakeSandbox.files.write.mockClear();
    fakeSandbox.files.read.mockClear();
  });

  // Without mapping, the agent's `/src/app.js` went to the VM's filesystem root and the
  // cloned repository was invisible to every file tool.
  it("writes into the cloned repo and reports the project-relative path", async () => {
    const sandbox = new E2BSandbox({ cwd: ROOT });
    const result = await sandbox.write("/migrated/app.py", "print('hi')");

    expect(fakeSandbox.files.write).toHaveBeenCalledWith(`${ROOT}/migrated/app.py`, expect.anything());
    expect(result.path).toBe("/migrated/app.py");
  });

  it("reads project memory from the repo, not the sandbox user's home", async () => {
    const sandbox = new E2BSandbox({ cwd: ROOT });
    await sandbox.downloadFiles(["./.deepagents/AGENTS.md"]);

    expect(fakeSandbox.files.read).toHaveBeenCalledWith(`${ROOT}/.deepagents/AGENTS.md`, { format: "bytes" });
  });

  it("searches inside the repo and returns project-relative match paths", async () => {
    fakeSandbox.commands.run.mockResolvedValueOnce({ stdout: `${ROOT}/src/app.js:3:const hello = 1;`, stderr: "", exitCode: 0 });
    const sandbox = new E2BSandbox({ cwd: ROOT });

    const result = await sandbox.grep("hello", "/src");

    expect(fakeSandbox.commands.run.mock.calls[0][0]).toContain(`${ROOT}/src`);
    expect(result.matches).toEqual([{ path: "/src/app.js", line: 3, text: "const hello = 1;" }]);
  });

  // An absent optional file (like a project with no AGENTS.md) must read as "not found", which
  // callers skip quietly — not as a failure.
  it("reports E2B's typed missing-file error as file_not_found", async () => {
    fakeSandbox.files.read.mockRejectedValueOnce(new NotFoundError("path does not exist"));
    const sandbox = new E2BSandbox({ cwd: ROOT });

    const [result] = await sandbox.downloadFiles(["/nope.md"]);

    expect(result.error).toBe("file_not_found");
    expect(result.path).toBe("/nope.md");
  });
});

// The SDK throws on a non-zero exit instead of returning it, so every `exitCode !== 0` check
// written against its result was unreachable until this helper.
describe("runInSandbox", () => {
  const e2b = fakeSandbox as unknown as Parameters<typeof runInSandbox>[0];

  it("returns a failed command's result instead of throwing", async () => {
    fakeSandbox.commands.run.mockRejectedValueOnce(new CommandExitError({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository" }));
    await expect(runInSandbox(e2b, "git status")).resolves.toEqual({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository" });
  });

  it("still throws when the sandbox itself fails", async () => {
    fakeSandbox.commands.run.mockRejectedValueOnce(new Error("sandbox was reclaimed"));
    await expect(runInSandbox(e2b, "git status")).rejects.toThrow("sandbox was reclaimed");
  });
});
