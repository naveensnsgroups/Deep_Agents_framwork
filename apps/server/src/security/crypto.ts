import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Everything here is keyed from one operator secret, APP_SECRET, with a separate derived key per
 * purpose. One secret keeps setup to a single SSM parameter; separate derivations mean a key used
 * to sign cookies is never also the key that decrypts stored API keys.
 *
 * Read on each call rather than at import: ESM evaluates this module before server.ts loads `.env`.
 */
function appSecret(): string {
  const secret = process.env.APP_SECRET?.trim() ?? "";
  if (secret.length < 32) throw new Error("APP_SECRET must be set to at least 32 characters");
  return secret;
}

export function hasAppSecret(): boolean {
  return (process.env.APP_SECRET?.trim() ?? "").length >= 32;
}

function derivedKey(purpose: "session:v1" | "user-secrets:v1"): Buffer {
  return Buffer.from(hkdfSync("sha256", appSecret(), "deepagents-ide", purpose, 32));
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

/**
 * A signed, expiring value for the session cookie — `<payload>.<hmac>`, both base64url.
 *
 * Stateless on purpose: nothing to store, and a session survives redeploys and restarts because
 * any instance holding APP_SECRET can verify it. Rotating APP_SECRET signs everyone out.
 */
export function signToken(payload: Record<string, unknown>, ttlSeconds: number, now = Date.now()): string {
  const body = b64url(JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSeconds }));
  const mac = createHmac("sha256", derivedKey("session:v1")).update(body).digest();
  return `${body}.${b64url(mac)}`;
}

/** Null for anything malformed, forged or expired — callers never need to tell those apart. */
export function verifyToken<T extends Record<string, unknown>>(token: string, now = Date.now()): T | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
  const body = token.slice(0, dot);

  const expected = createHmac("sha256", derivedKey("session:v1")).update(body).digest();
  const actual = Buffer.from(token.slice(dot + 1), "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp?: unknown };
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

export interface EncryptedValue {
  v: 1;
  iv: string;
  tag: string;
  data: string;
}

/**
 * AES-256-GCM. `context` is bound in as additional authenticated data — callers pass the owning
 * user and the key's name — so a ciphertext copied onto another user's record, or under another
 * provider's name, fails to decrypt instead of quietly becoming that user's key.
 */
export function encryptSecret(plaintext: string, context: string): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derivedKey("user-secrets:v1"), iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { v: 1, iv: b64url(iv), tag: b64url(cipher.getAuthTag()), data: b64url(data) };
}

export function decryptSecret(value: EncryptedValue, context: string): string {
  const decipher = createDecipheriv("aes-256-gcm", derivedKey("user-secrets:v1"), Buffer.from(value.iv, "base64url"));
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(value.data, "base64url")), decipher.final()]).toString("utf8");
}

export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

/** Constant-time comparison for short secrets such as the OAuth state value. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
