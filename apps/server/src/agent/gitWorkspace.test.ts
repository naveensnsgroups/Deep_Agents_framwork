import { describe, expect, it } from "vitest";
import { assertGitHubRepo, assertNoEmbeddedCredentials } from "./gitWorkspace.js";

/** Everything typed into the project box becomes an argument to `git`. */
describe("assertGitHubRepo", () => {
  it.each([
    "https://github.com/user/repo",
    "https://github.com/user/repo.git",
    "https://github.com/user/repo/",
    "https://github.com/my-org/my.repo_v2",
    "https://github.com/user/repo#feature/login-v2",
    "  https://github.com/user/repo#main  ",
  ])("accepts %s", (input) => {
    expect(() => assertGitHubRepo(input)).not.toThrow();
  });

  it.each([
    ["an option git would parse", "--upload-pack=touch /tmp/pwned;.git"],
    ["another host", "https://gitlab.com/user/repo"],
    ["plain http", "http://github.com/user/repo"],
    ["the SSH form", "git@github.com:user/repo.git"],
    ["a non-http transport", "ext::sh -c touch% /tmp/pwned.git"],
    ["a local path", "/srv/app.git"],
    ["a path climb as the repo", "https://github.com/user/.."],
    ["an extra path segment", "https://github.com/user/repo/tree/main"],
    ["a host look-alike", "https://github.com.evil.example/user/repo"],
  ])("rejects %s", (_label, input) => {
    expect(() => assertGitHubRepo(input)).toThrow(/Only GitHub repositories/);
  });

  it.each(["-evil", "main..other", "bad branch", "x;rm -rf ~"])("rejects the branch %s", (branch) => {
    expect(() => assertGitHubRepo(`https://github.com/user/repo#${branch}`)).toThrow(/not a valid branch/);
  });

  it("still refuses credentials in the URL", () => {
    expect(() => assertGitHubRepo("https://ghp_abc@github.com/user/repo")).toThrow(/contains credentials/);
  });
});

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
