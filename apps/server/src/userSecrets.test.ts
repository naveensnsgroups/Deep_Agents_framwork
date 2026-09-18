import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  deleteUserSecret,
  getUserSecret,
  GITHUB_OAUTH_SECRET,
  inMemoryBacking,
  listUserKeys,
  saveUserSecret,
  useSecretsBackingForTests,
} from "./userSecrets.js";

beforeAll(() => {
  process.env.APP_SECRET = "test-app-secret-that-is-long-enough-0123456789";
});

beforeEach(() => useSecretsBackingForTests(inMemoryBacking()));
afterEach(() => useSecretsBackingForTests(undefined));

describe("user secrets", () => {
  it("saves, reads back and deletes a key", async () => {
    await saveUserSecret("gh:1", "openai", "sk-alice", "alice");
    expect(await getUserSecret("gh:1", "openai")).toBe("sk-alice");

    await deleteUserSecret("gh:1", "openai");
    expect(await getUserSecret("gh:1", "openai")).toBeUndefined();
  });

  it("keeps each user's keys separate", async () => {
    await saveUserSecret("gh:1", "openai", "sk-alice");
    expect(await getUserSecret("gh:2", "openai")).toBeUndefined();
  });

  // The listing goes to the browser, so it must say which keys exist and nothing more.
  it("lists key status without values, and reports the GitHub login token separately", async () => {
    await saveUserSecret("gh:1", "openrouter", "sk-or-secret-value");
    await saveUserSecret("gh:1", GITHUB_OAUTH_SECRET, "gho_oauth_value");

    const listing = await listUserKeys("gh:1");
    expect(JSON.stringify(listing)).not.toContain("secret-value");
    expect(JSON.stringify(listing)).not.toContain("gho_oauth_value");
    expect(listing.githubLinked).toBe(true);
    expect(listing.keys.find((k) => k.name === "openrouter")?.saved).toBe(true);
    expect(listing.keys.find((k) => k.name === "openai")?.saved).toBe(false);
    expect(listing.keys.some((k) => (k.name as string) === GITHUB_OAUTH_SECRET)).toBe(false);
  });

  it("treats a key that no longer decrypts as not saved", async () => {
    await saveUserSecret("gh:1", "openai", "sk-alice");
    const original = process.env.APP_SECRET;
    process.env.APP_SECRET = "rotated-secret-rotated-secret-rotated-0123456789";
    try {
      expect(await getUserSecret("gh:1", "openai")).toBeUndefined();
    } finally {
      process.env.APP_SECRET = original;
    }
  });
});
