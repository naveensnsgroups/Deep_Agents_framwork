import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertAuthConfig,
  authenticateRequest,
  authorizeUpgrade,
  authMode,
  isGithubUserAllowed,
  parseCookies,
  requireAuth,
  sessionCookie,
  userForUpgrade,
  userScope,
} from "./auth.js";
import { githubAuthRouter } from "./routes/githubAuth.js";

const ENV_KEYS = [
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "APP_SECRET",
  "PUBLIC_URL",
  "ALLOWED_GITHUB_USERS",
  "ALLOWED_ORIGINS",
  "AUTH_TOKEN",
  "CLOUD_MODE",
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function enableGithubLogin() {
  process.env.GITHUB_OAUTH_CLIENT_ID = "client-id";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "client-secret";
  process.env.APP_SECRET = "test-app-secret-that-is-long-enough-0123456789";
  process.env.PUBLIC_URL = "http://13.202.56.144";
  process.env.ALLOWED_GITHUB_USERS = "Alice, bob";
}

const alice = { id: "gh:1", login: "alice" };

function cookieHeaderFor(user: { id: string; login: string }): string {
  return sessionCookie(user).split(";")[0];
}

describe("auth mode selection", () => {
  it("prefers GitHub login, then the shared token, then none", () => {
    expect(authMode()).toBe("none");
    process.env.AUTH_TOKEN = "t";
    expect(authMode()).toBe("token");
    process.env.GITHUB_OAUTH_CLIENT_ID = "id";
    expect(authMode()).toBe("oauth");
  });

  it("scopes data per user only under GitHub login", () => {
    expect(userScope(alice)).toBeUndefined();
    enableGithubLogin();
    expect(userScope(alice)).toBe("gh:1");
  });
});

describe("startup configuration", () => {
  it("refuses GitHub login with anything required missing", () => {
    process.env.GITHUB_OAUTH_CLIENT_ID = "client-id";
    expect(() => assertAuthConfig()).toThrow(/GITHUB_OAUTH_CLIENT_SECRET.*APP_SECRET.*PUBLIC_URL.*ALLOWED_GITHUB_USERS/);
  });

  it("refuses a cloud deployment with no authentication at all", () => {
    process.env.CLOUD_MODE = "1";
    expect(() => assertAuthConfig()).toThrow(/Refusing to start/);
  });

  it("accepts a complete GitHub login configuration", () => {
    enableGithubLogin();
    expect(() => assertAuthConfig()).not.toThrow();
  });
});

describe("allowlist", () => {
  it("matches usernames case-insensitively and supports *", () => {
    process.env.ALLOWED_GITHUB_USERS = "Alice, bob";
    expect(isGithubUserAllowed("alice")).toBe(true);
    expect(isGithubUserAllowed("BOB")).toBe(true);
    expect(isGithubUserAllowed("mallory")).toBe(false);
    process.env.ALLOWED_GITHUB_USERS = "*";
    expect(isGithubUserAllowed("anyone")).toBe(true);
  });
});

describe("session cookie authentication", () => {
  it("accepts a valid session and rejects a missing or forged one", () => {
    enableGithubLogin();
    expect(authenticateRequest({ cookie: cookieHeaderFor(alice) })).toMatchObject(alice);
    expect(authenticateRequest({})).toBeNull();
    expect(authenticateRequest({ cookie: "da_session=forged.value" })).toBeNull();
  });

  // Removing someone from the allowlist must take effect before their cookie expires.
  it("rejects a valid session once the user is removed from the allowlist", () => {
    enableGithubLogin();
    const cookie = cookieHeaderFor(alice);
    process.env.ALLOWED_GITHUB_USERS = "bob";
    expect(authenticateRequest({ cookie })).toBeNull();
  });

  it("does not accept the shared token in place of a session", () => {
    enableGithubLogin();
    process.env.AUTH_TOKEN = "shared";
    expect(authenticateRequest({ authorization: "Bearer shared" })).toBeNull();
  });

  it("marks the cookie HttpOnly and SameSite=Lax, and Secure only over https", () => {
    enableGithubLogin();
    expect(sessionCookie(alice)).toMatch(/HttpOnly; SameSite=Lax/);
    expect(sessionCookie(alice)).not.toMatch(/Secure/);
    process.env.PUBLIC_URL = "https://app.example.com";
    expect(sessionCookie(alice)).toMatch(/; Secure/);
  });

  it("parses cookie headers", () => {
    expect(parseCookies("a=1; da_session=x.y; b=%20z")).toEqual({ a: "1", da_session: "x.y", b: " z" });
  });
});

describe("WebSocket handshakes", () => {
  function upgrade(headers: http.IncomingHttpHeaders) {
    return { headers } as http.IncomingMessage;
  }

  // Another site can make the browser open a socket carrying the session cookie; the Origin
  // check is what stops that site from driving the agent as the user.
  it("requires a trusted Origin as well as a session under GitHub login", () => {
    enableGithubLogin();
    const cookie = cookieHeaderFor(alice);

    const trusted = upgrade({ cookie, origin: "http://13.202.56.144" });
    expect(authorizeUpgrade(trusted)).toMatchObject(alice);
    expect(userForUpgrade(trusted)).toMatchObject(alice);

    expect(authorizeUpgrade(upgrade({ cookie, origin: "https://evil.example" }))).toBeNull();
    expect(authorizeUpgrade(upgrade({ cookie }))).toBeNull();
    expect(authorizeUpgrade(upgrade({ origin: "http://13.202.56.144" }))).toBeNull();
  });

  it("still accepts the token subprotocol in shared-token mode", () => {
    process.env.AUTH_TOKEN = "shared-token";
    expect(authorizeUpgrade(upgrade({ "sec-websocket-protocol": "bearer, shared-token" }))).not.toBeNull();
    expect(authorizeUpgrade(upgrade({ "sec-websocket-protocol": "bearer, wrong" }))).toBeNull();
  });
});

describe("HTTP routes", () => {
  let server: http.Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use("/auth", githubAuthRouter());
    app.get("/api/thing", requireAuth, (_req, res) => res.json({ ok: true }));
    app.put("/api/thing", requireAuth, (_req, res) => res.json({ ok: true }));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  // Under cookie sessions the browser attaches the cookie to other sites' requests too.
  it("rejects state-changing requests from an untrusted origin", async () => {
    enableGithubLogin();
    const cookie = cookieHeaderFor(alice);

    expect((await fetch(`${base}/api/thing`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${base}/api/thing`, { method: "PUT", headers: { cookie, origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/api/thing`, { method: "PUT", headers: { cookie, origin: "http://13.202.56.144" } })).status).toBe(200);
    expect((await fetch(`${base}/api/thing`)).status).toBe(401);
  });

  it("starts login with a state cookie and GitHub redirect", async () => {
    enableGithubLogin();
    const res = await fetch(`${base}/auth/github/login`, { redirect: "manual" });
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("redirect_uri")).toBe("http://13.202.56.144/auth/github/callback");
    expect(location.searchParams.get("scope")).toBe("repo read:user");

    const state = location.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(res.headers.get("set-cookie")).toContain(`da_oauth_state=${state}`);
  });

  // Without the state check, a crafted callback link could sign a victim into the attacker's account.
  it("rejects a callback whose state does not match the cookie", async () => {
    enableGithubLogin();
    const res = await fetch(`${base}/auth/github/callback?code=abc&state=attacker`, {
      redirect: "manual",
      headers: { cookie: "da_oauth_state=legit" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?auth_error=bad_state");
    expect(res.headers.get("set-cookie") ?? "").not.toContain("da_session=ey");
  });

  it("does not offer login when GitHub login is off", async () => {
    expect((await fetch(`${base}/auth/github/login`, { redirect: "manual" })).status).toBe(404);
  });
});
