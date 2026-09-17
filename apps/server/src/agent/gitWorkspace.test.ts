import { describe, expect, it } from "vitest";
import { assertNoEmbeddedCredentials } from "./gitWorkspace.js";

describe("assertNoEmbeddedCredentials", () => {
  it.each([
    "https://ghp_abc123@github.com/user/repo",
    "https://x-access-token:ghp_abc123@github.com/user/repo.git",
    "  https://user:pass@github.com/user/repo#main  ",
  ])("rejects %s", (url) => {
    expect(() => assertNoEmbeddedCredentials(url)).toThrow(/contains credentials/);
  });

  it("never echoes the credential back in the error", () => {
    expect(() => assertNoEmbeddedCredentials("https://ghp_SECRETVALUE@github.com/u/r")).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("ghp_SECRETVALUE") })
    );
  });

  it.each([
    "https://github.com/user/repo",
    "https://github.com/user/repo#feature-x",
    "git@github.com:user/repo.git",
    "E:\\projects\\app",
    "/home/user/project",
  ])("accepts %s", (input) => {
    expect(() => assertNoEmbeddedCredentials(input)).not.toThrow();
  });
});
