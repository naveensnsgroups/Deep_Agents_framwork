import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { completeGithubLogin, GithubLoginError } from "./githubAuth.js";
import { getUserSecret, GITHUB_OAUTH_SECRET, inMemoryBacking, useSecretsBackingForTests } from "../userSecrets.js";

beforeEach(() => {
  process.env.GITHUB_OAUTH_CLIENT_ID = "client-id";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "client-secret";
  process.env.APP_SECRET = "test-app-secret-that-is-long-enough-0123456789";
  process.env.PUBLIC_URL = "http://13.202.56.144";
  process.env.ALLOWED_GITHUB_USERS = "alice";
  useSecretsBackingForTests(inMemoryBacking());
});
afterEach(() => {
  for (const k of ["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET", "PUBLIC_URL", "ALLOWED_GITHUB_USERS"]) delete process.env[k];
  useSecretsBackingForTests(undefined);
});

function fakeGithub(profile: Record<string, unknown>, tokenBody: Record<string, unknown> = { access_token: "gho_token" }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const body = url.includes("access_token") ? tokenBody : profile;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

describe("completeGithubLogin", () => {
  it("returns the user keyed by numeric id and stores the token encrypted for them", async () => {
    const { impl, calls } = fakeGithub({ id: 42, login: "Alice", name: "Alice A", avatar_url: "https://avatars/x" });

    const user = await completeGithubLogin("code-1", impl);

    expect(user).toEqual({ id: "gh:42", login: "Alice", name: "Alice A", avatarUrl: "https://avatars/x" });
    expect(await getUserSecret("gh:42", GITHUB_OAUTH_SECRET)).toBe("gho_token");

    const exchange = JSON.parse(String(calls[0].init?.body));
    expect(exchange).toMatchObject({ client_id: "client-id", code: "code-1", redirect_uri: "http://13.202.56.144/auth/github/callback" });
    expect(new Headers(calls[1].init?.headers).get("authorization")).toBe("Bearer gho_token");
  });

  it("refuses a user who is not on the allowlist and stores nothing for them", async () => {
    const { impl } = fakeGithub({ id: 7, login: "mallory" });
    await expect(completeGithubLogin("code", impl)).rejects.toMatchObject({ reason: "not_allowed" });
    expect(await getUserSecret("gh:7", GITHUB_OAUTH_SECRET)).toBeUndefined();
  });

  it("reports GitHub rejecting the code", async () => {
    const { impl } = fakeGithub({ id: 42, login: "alice" }, { error: "bad_verification_code" });
    const failure = completeGithubLogin("expired", impl);
    await expect(failure).rejects.toBeInstanceOf(GithubLoginError);
    await expect(failure).rejects.toMatchObject({ reason: "github_error" });
  });
});
