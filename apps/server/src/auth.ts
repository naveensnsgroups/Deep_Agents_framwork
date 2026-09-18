import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { IncomingMessage } from "node:http";
import type { AuthMode, SessionUser } from "@deepagents-ide/shared";
import { hasAppSecret, signToken, verifyToken } from "./security/crypto.js";

/**
 * Three ways to run, picked by configuration:
 *
 * - "oauth": GitHub login. Each person is their own user with their own keys, chats, memories
 *   and sandboxes. Used whenever GITHUB_OAUTH_CLIENT_ID is set.
 * - "token": one shared AUTH_TOKEN. Everyone who has it is the same user.
 * - "none": no authentication — local development only.
 *
 * Every environment read in this file is a function call rather than a module constant. ESM
 * hoists imports above the importing module's own statements, so server.ts's `dotenv.config()`
 * runs after this file is evaluated — a constant would capture the variable before `.env` was
 * loaded, which for these means booting wide open while believing authentication is on.
 */
export function authMode(): AuthMode {
  if (process.env.GITHUB_OAUTH_CLIENT_ID?.trim()) return "oauth";
  if (authToken()) return "token";
  return "none";
}

/** Stands for "whoever is using this server" when there are no separate accounts. */
export const LOCAL_USER: SessionUser = { id: "local", login: "local" };

/**
 * The id that scopes data to a person, or undefined when everyone shares one scope. Only GitHub
 * login separates users; in the other modes this stays undefined so existing single-user data
 * (thread ids, the shared memories namespace) keeps working unchanged.
 */
export function userScope(user: SessionUser): string | undefined {
  return authMode() === "oauth" ? user.id : undefined;
}

function authToken(): string {
  return process.env.AUTH_TOKEN?.trim() ?? "";
}

/**
 * Set on any deployment reachable from somewhere other than localhost. It makes authentication
 * mandatory (see assertAuthConfig) and switches off the local-disk folder browser, which exists
 * to pick a folder on the user's own machine and is pure filesystem reconnaissance once the
 * backend is somewhere else.
 */
export function isCloudMode(): boolean {
  return process.env.CLOUD_MODE?.trim() === "1";
}

export function isAuthEnabled(): boolean {
  return authMode() !== "none";
}

/** Where this deployment is reached, e.g. http://13.202.56.144 — the OAuth callback is built from it. */
export function publicUrl(): string {
  return (process.env.PUBLIC_URL?.trim() ?? "").replace(/\/+$/, "");
}

/**
 * GitHub usernames allowed to sign in, lower-cased. "*" allows any GitHub account — only
 * sensible when nobody can spend the operator's money, since every sandbox runs on the
 * operator's E2B account regardless of whose model keys are used.
 */
export function allowedGithubUsers(): Set<string> {
  return new Set(
    (process.env.ALLOWED_GITHUB_USERS ?? "")
      .split(",")
      .map((u) => u.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isGithubUserAllowed(login: string): boolean {
  const allowed = allowedGithubUsers();
  return allowed.has("*") || allowed.has(login.toLowerCase());
}

/**
 * Refuses to boot a deployment whose authentication would silently not work — the failure mode
 * of a missing variable is "anyone on the internet has a shell", or a login button that can never
 * succeed, neither of which should be left to a log line nobody reads.
 */
export function assertAuthConfig(): void {
  const mode = authMode();

  if (mode === "oauth") {
    const missing = [
      !process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim() && "GITHUB_OAUTH_CLIENT_SECRET",
      !hasAppSecret() && "APP_SECRET (at least 32 characters)",
      !publicUrl() && "PUBLIC_URL",
      allowedGithubUsers().size === 0 && "ALLOWED_GITHUB_USERS",
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`GitHub login is enabled (GITHUB_OAUTH_CLIENT_ID is set) but these are missing: ${missing.join(", ")}.`);
    }
    try {
      new URL(publicUrl());
    } catch {
      throw new Error("PUBLIC_URL must be a full URL, e.g. http://13.202.56.144");
    }
    return;
  }

  if (isCloudMode() && mode === "none") {
    throw new Error("CLOUD_MODE=1 requires GitHub login or AUTH_TOKEN. Refusing to start without authentication.");
  }
  if (mode === "none") {
    console.warn("[auth] No authentication configured — every endpoint is open. Local development only.");
  }
}

// ---------------------------------------------------------------------------------------------
// Session cookie (GitHub login mode)

export const SESSION_COOKIE = "da_session";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

interface SessionPayload extends Record<string, unknown> {
  sub: string;
  login: string;
  name?: string;
  avatar?: string;
}

/**
 * HttpOnly so page scripts — including anything injected into the page — cannot read it.
 * SameSite=Lax so other sites' forms, fetches and WebSocket handshakes don't carry it, while the
 * top-level redirect back from GitHub still does. Secure whenever the public URL is https.
 */
export function cookieAttributes(maxAgeSeconds: number, cookiePath = "/"): string {
  const secure = publicUrl().startsWith("https://") ? "; Secure" : "";
  return `Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function sessionCookie(user: SessionUser): string {
  const token = signToken(
    { sub: user.id, login: user.login, name: user.name, avatar: user.avatarUrl } satisfies SessionPayload,
    SESSION_TTL_SECONDS
  );
  return `${SESSION_COOKIE}=${token}; ${cookieAttributes(SESSION_TTL_SECONDS)}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; ${cookieAttributes(0)}`;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;
    try {
      out[name] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[name] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/**
 * Also re-checks the allowlist, not just the signature: removing someone from
 * ALLOWED_GITHUB_USERS has to lock them out on their next request, not in a week when the
 * cookie expires.
 */
function userFromSessionCookie(cookieHeader: string | undefined): SessionUser | null {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token) return null;
  const payload = verifyToken<SessionPayload>(token);
  if (!payload || typeof payload.sub !== "string" || typeof payload.login !== "string") return null;
  if (!isGithubUserAllowed(payload.login)) return null;
  return { id: payload.sub, login: payload.login, name: payload.name, avatarUrl: payload.avatar };
}

// ---------------------------------------------------------------------------------------------
// Shared-token mode

/** Length is compared first because timingSafeEqual throws on a length mismatch. */
function tokenMatches(candidate: string): boolean {
  const expected = Buffer.from(authToken());
  const actual = Buffer.from(candidate);
  return expected.length > 0 && expected.length === actual.length && timingSafeEqual(expected, actual);
}

function bearerFrom(header: string | undefined): string {
  if (!header) return "";
  const [scheme, ...rest] = header.split(" ");
  return scheme.toLowerCase() === "bearer" ? rest.join(" ").trim() : "";
}

// ---------------------------------------------------------------------------------------------
// Origin checks (GitHub login mode)

/** The deployment's own origin plus anything listed in ALLOWED_ORIGINS. */
export function trustedOrigins(): Set<string> {
  const origins = new Set(
    (process.env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim().replace(/\/+$/, ""))
      .filter(Boolean)
  );
  try {
    if (publicUrl()) origins.add(new URL(publicUrl()).origin);
  } catch {
    // assertAuthConfig reports a malformed PUBLIC_URL at startup
  }
  return origins;
}

/**
 * A cookie is sent by the browser no matter which page started the request, so under cookie
 * sessions any other site could otherwise drive a state-changing call — or open the agent socket —
 * as the signed-in user. Browsers always send Origin on those requests, so requiring a trusted one
 * shuts that off. Bearer-token mode doesn't need this: another site has no way to attach the token.
 */
export function isTrustedOrigin(origin: string | undefined): boolean {
  if (authMode() !== "oauth") return true;
  return Boolean(origin) && trustedOrigins().has(origin!.replace(/\/+$/, ""));
}

// ---------------------------------------------------------------------------------------------
// Express and WebSocket entry points

/** The authenticated user for a request that passed requireAuth. */
export function currentUser(res: Response): SessionUser {
  return (res.locals.user as SessionUser | undefined) ?? LOCAL_USER;
}

export function authenticateRequest(headers: IncomingMessage["headers"]): SessionUser | null {
  switch (authMode()) {
    case "none":
      return LOCAL_USER;
    case "token":
      return tokenMatches(bearerFrom(headers.authorization)) ? LOCAL_USER : null;
    case "oauth":
      return userFromSessionCookie(headers.cookie);
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = authenticateRequest(req.headers);
  if (!user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD" && !isTrustedOrigin(req.headers.origin)) {
    res.status(403).json({ error: "Untrusted origin" });
    return;
  }
  res.locals.user = user;
  next();
}

/**
 * `/gemini-proxy` is called by this process itself (see agent/models.ts, which points the
 * Gemini client at `http://localhost:<port>/gemini-proxy` to strip schema keywords the API
 * rejects), never by the browser — so it takes no credentials and a `requireAuth` on it
 * would break Gemini outright. It is still bound to the public interface along with
 * everything else, so it gets the guard that actually fits: loopback callers only.
 */
export function localhostOnly(req: Request, res: Response, next: NextFunction): void {
  const addr = req.socket.remoteAddress ?? "";
  if (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1") return next();
  res.status(403).json({ error: "Forbidden" });
}

const upgradeUsers = new WeakMap<IncomingMessage, SessionUser>();

/**
 * Checks a WebSocket handshake and remembers who it belongs to, for the connection handler to
 * read with `userForUpgrade`.
 *
 * Token mode: browsers cannot set headers on a WebSocket handshake, and a token in the query
 * string leaks into proxy logs and Referer headers. The subprotocol list is the one
 * client-settable handshake header, so the client offers ["bearer", "<token>"] and the server
 * selects "bearer" back (see selectSubprotocol) to complete the handshake.
 *
 * GitHub login mode: the session cookie rides along automatically, and the Origin is checked —
 * see isTrustedOrigin.
 */
export function authorizeUpgrade(request: IncomingMessage): SessionUser | null {
  let user: SessionUser | null;
  switch (authMode()) {
    case "none":
      user = LOCAL_USER;
      break;
    case "token": {
      const offered = String(request.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      user = offered.some((p) => p !== "bearer" && tokenMatches(p)) ? LOCAL_USER : null;
      break;
    }
    case "oauth":
      user = isTrustedOrigin(request.headers.origin) ? userFromSessionCookie(request.headers.cookie) : null;
      break;
  }
  if (user) upgradeUsers.set(request, user);
  return user;
}

export function userForUpgrade(request: IncomingMessage): SessionUser {
  return upgradeUsers.get(request) ?? LOCAL_USER;
}

/**
 * Never echoes the token back — the browser only requires that the server pick one of the
 * protocols it offered, and "bearer" is the non-secret half of the pair.
 */
export function selectSubprotocol(protocols: Set<string>): string | false {
  return protocols.has("bearer") ? "bearer" : false;
}
