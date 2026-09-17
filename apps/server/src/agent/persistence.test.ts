import { describe, expect, it } from "vitest";
import { InMemoryStore } from "@langchain/langgraph";
import { RunnableLambda } from "@langchain/core/runnables";
import type { AnyBackendProtocol } from "deepagents";
import { memoriesBackend } from "./persistence.js";

/** Runs `fn` inside a runnable so the backend resolves its namespace from this config. */
function asUser<T>(userId: string | undefined, fn: () => Promise<T>): Promise<T> {
  const configurable = userId ? { user_id: userId } : {};
  return RunnableLambda.from(fn).invoke(undefined, { configurable });
}

async function readText(backend: AnyBackendProtocol, filePath: string): Promise<string> {
  return JSON.stringify(await (backend as unknown as { read(p: string): Promise<unknown> }).read(filePath));
}

describe("memories backend", () => {
  // Shared memory is a prompt-injection path between users: whatever one user's agent writes,
  // another user's agent would read as its own notes.
  it("keeps each user's memories separate", async () => {
    const backend = memoriesBackend(new InMemoryStore()) as unknown as {
      write(p: string, c: string): Promise<unknown>;
    };

    await asUser("alice", () => backend.write("/prefs.md", "alice-secret-note"));

    expect(await asUser("alice", () => readText(backend as never, "/prefs.md"))).toContain("alice-secret-note");
    expect(await asUser("bob", () => readText(backend as never, "/prefs.md"))).not.toContain("alice-secret-note");
    expect(await asUser(undefined, () => readText(backend as never, "/prefs.md"))).not.toContain("alice-secret-note");
  });
});
