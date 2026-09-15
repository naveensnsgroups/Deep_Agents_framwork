import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { IncomingMessage } from "node:http";

/**
 * A single shared bearer token. Deliberately not per-user accounts: this app has no user
 * model yet, and the goal here is to stop an open URL from being a free shell on the host,
 * not to tell two people apart. Real accounts belong with the per-user workspace isolation
 * that would have to land alongside them.
 *
 * Every environment read in this file is a function call rather than a module constant. ESM
 * hoists imports above the importing module's own statements, so server.ts's
 * `dotenv.config()` runs after this file is evaluated — a constant would capture the
 * variable before `.env` was loaded, which for these two means booting wide open while
 * believing authentication is on.
 */
function authToken(): string {
  return process.env.AUTH_TOKEN?.trim() ?? "";
}

/**
 * Set on any deployment reachable from somewhere other than localhost. It makes the auth
 * token mandatory (see assertAuthConfig) and switches off the local-disk folder browser,
 * which exists to pick a folder on the user's own machine and is pure filesystem
 * reconnaissance once the backend is somewhere else.
 */
export function isCloudMode(): boolean {
  return process.env.CLOUD_MODE?.trim() === "1";
}

export function isAuthEnabled(): boolean {
  return authToken().length > 0;
}

/**
 * Refuses to boot a cloud deployment with no token rather than starting one that is wide
 * open — the failure mode of forgetting this variable is "anyone on the internet has a
 * shell", which is not something to leave to a log line nobody reads.
 */
export function assertAuthConfig(): void {
  if (isCloudMode() && !isAuthEnabled()) {
    throw new Error("CLOUD_MODE=1 requires AUTH_TOKEN to be set. Refusing to start without authentication.");
  }
  if (!isAuthEnabled()) {
    console.warn("[auth] AUTH_TOKEN is not set — every endpoint is unauthenticated. Local development only.");
  }
}

/** Length is compared first because timingSafeEqual throws on a length mismatch. */
function tokenMatches(candidate: string): boolean {
  const expected = Buffer.from(authToken());
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function bearerFrom(header: string | undefined): string {
  if (!header) return "";
  const [scheme, ...rest] = header.split(" ");
  return scheme.toLowerCase() === "bearer" ? rest.join(" ").trim() : "";
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthEnabled()) return next();
  if (tokenMatches(bearerFrom(req.headers.authorization))) return next();
  res.status(401).json({ error: "Unauthorized" });
}

/**
 * `/gemini-proxy` is called by this process itself (see agent/models.ts, which points the
 * Gemini client at `http://localhost:<port>/gemini-proxy` to strip schema keywords the API
 * rejects), never by the browser — so it takes no bearer token and a `requireAuth` on it
 * would break Gemini outright. It is still bound to the public interface along with
 * everything else, so it gets the guard that actually fits: loopback callers only.
 */
export function localhostOnly(req: Request, res: Response, next: NextFunction): void {
  const addr = req.socket.remoteAddress ?? "";
  if (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1") return next();
  res.status(403).json({ error: "Forbidden" });
}

/**
 * Browsers cannot set headers on a WebSocket handshake, and a token in the query string
 * leaks into proxy logs and Referer headers. The subprotocol list is the one client-settable
 * handshake header, so the client offers ["bearer", "<token>"] and the server selects
 * "bearer" back (see selectSubprotocol) to complete the handshake.
 */
export function authorizeUpgrade(request: IncomingMessage): boolean {
  if (!isAuthEnabled()) return true;
  const offered = String(request.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  return offered.some((p) => p !== "bearer" && tokenMatches(p));
}

/**
 * Never echoes the token back — the browser only requires that the server pick one of the
 * protocols it offered, and "bearer" is the non-secret half of the pair.
 */
export function selectSubprotocol(protocols: Set<string>): string | false {
  return protocols.has("bearer") ? "bearer" : false;
}
