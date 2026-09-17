import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeSandbox = { sandboxId: "sbx-test", setTimeout: vi.fn(async () => {}), kill: vi.fn(async () => {}) };

vi.mock("e2b", () => ({
  Sandbox: { create: vi.fn(async () => fakeSandbox) },
  CommandExitError: class extends Error {},
}));

const { E2BSandbox } = await import("./e2bSandbox.js");

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
