import { Router } from "express";
import type { SessionUser } from "@deepagents-ide/shared";
import {
  authMode,
  clearedSessionCookie,
  cookieAttributes,
  isGithubUserAllowed,
  isTrustedOrigin,
  parseCookies,
  publicUrl,
  sessionCookie,
} from "../auth.js";
import { randomToken, safeEqual } from "../security/crypto.js";
import { GITHUB_OAUTH_SECRET, saveUserSecret } from "../userSecrets.js";

const STATE_COOKIE = "da_oauth_state";
const STATE_TTL_SECONDS = 10 * 60;

/**
 * `repo` lets the login itself clone private repositories and push, so nobody has to paste a
 * personal access token; `read:user` is what identifies them.
 */
const SCOPES = "repo read:user";

type Fetch = typeof fetch;

export type LoginFailure = "not_allowed" | "github_error";

export class GithubLoginError extends Error {
  constructor(readonly reason: LoginFailure, message: string) {
    super(message);
  }
}

function redirectUri(): string {
  return `${publicUrl()}/auth/github/callback`;
}

/**
 * Exchanges the one-time code for an access token, looks up who it belongs to, applies the
 * allowlist and stores the token encrypted. Separated from the route so it can be exercised
 * without a browser or GitHub.
 */
export async function completeGithubLogin(code: string, fetchImpl: Fetch = fetch): Promise<SessionUser> {
  const tokenRes = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_OAUTH_CLIENT_ID?.trim(),
      client_secret: process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim(),
      code,
      redirect_uri: redirectUri(),
    }),
  });
  const tokenBody = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!tokenRes.ok || !tokenBody.access_token) {
    throw new GithubLoginError("github_error", `GitHub rejected the login code: ${tokenBody.error ?? tokenRes.status}`);
  }

  const userRes = await fetchImpl("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${tokenBody.access_token}`,
      "User-Agent": "deep-agents-ide",
    },
  });
  const profile = (await userRes.json().catch(() => ({}))) as { id?: number; login?: string; name?: string | null; avatar_url?: string };
  if (!userRes.ok || typeof profile.id !== "number" || !profile.login) {
    throw new GithubLoginError("github_error", `Could not read the GitHub profile: ${userRes.status}`);
  }

  if (!isGithubUserAllowed(profile.login)) {
    throw new GithubLoginError("not_allowed", `GitHub user ${profile.login} is not on the allowlist`);
  }

  // Keyed by GitHub's numeric id, not the login: a username can be renamed and later claimed by
  // someone else, who would otherwise inherit this person's keys, chats and memories.
  const user: SessionUser = {
    id: `gh:${profile.id}`,
    login: profile.login,
    name: profile.name ?? undefined,
    avatarUrl: profile.avatar_url,
  };
  await saveUserSecret(user.id, GITHUB_OAUTH_SECRET, tokenBody.access_token, user.login);
  return user;
}

/** Mounted before requireAuth — these are how a user gets a session in the first place. */
export function githubAuthRouter() {
  const router = Router();

  router.get("/github/login", (_req, res) => {
    if (authMode() !== "oauth") return res.status(404).json({ error: "GitHub login is not enabled" });

    // The state value ties the callback to a login this browser started, so a crafted callback
    // link cannot sign someone into an account the attacker chose.
    const state = randomToken(24);
    res.setHeader("Set-Cookie", `${STATE_COOKIE}=${state}; ${cookieAttributes(STATE_TTL_SECONDS, "/auth")}`);

    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", process.env.GITHUB_OAUTH_CLIENT_ID!.trim());
    url.searchParams.set("redirect_uri", redirectUri());
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("state", state);
    url.searchParams.set("allow_signup", "false");
    res.redirect(url.toString());
  });

  router.get("/github/callback", async (req, res) => {
    if (authMode() !== "oauth") return res.status(404).json({ error: "GitHub login is not enabled" });

    const clearState = `${STATE_COOKIE}=; ${cookieAttributes(0, "/auth")}`;
    const fail = (reason: LoginFailure | "bad_state" | "denied") => {
      res.setHeader("Set-Cookie", clearState);
      res.redirect(`/?auth_error=${reason}`);
    };

    if (typeof req.query.error === "string") return fail("denied");

    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const expected = parseCookies(req.headers.cookie)[STATE_COOKIE] ?? "";
    if (!code || !state || !expected || !safeEqual(state, expected)) return fail("bad_state");

    try {
      const user = await completeGithubLogin(code);
      res.setHeader("Set-Cookie", [clearState, sessionCookie(user)]);
      res.redirect("/");
    } catch (err) {
      console.error("[auth] GitHub login failed:", (err as Error).message);
      fail(err instanceof GithubLoginError ? err.reason : "github_error");
    }
  });

  router.post("/logout", (req, res) => {
    if (!isTrustedOrigin(req.headers.origin)) return res.status(403).json({ error: "Untrusted origin" });
    res.setHeader("Set-Cookie", clearedSessionCookie());
    res.json({ ok: true });
  });

  return router;
}
