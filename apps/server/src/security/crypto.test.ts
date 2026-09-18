import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, signToken, verifyToken } from "./crypto.js";

beforeAll(() => {
  process.env.APP_SECRET = "test-app-secret-that-is-long-enough-0123456789";
});

describe("session tokens", () => {
  it("round-trips a payload before it expires", () => {
    const token = signToken({ sub: "gh:1", login: "alice" }, 60);
    expect(verifyToken<{ sub: string; login: string }>(token)).toMatchObject({ sub: "gh:1", login: "alice" });
  });

  it("rejects an expired token", () => {
    const issued = Date.now() - 120_000;
    expect(verifyToken(signToken({ sub: "gh:1" }, 60, issued))).toBeNull();
  });

  // The cookie is the whole identity: if its body can be edited, anyone can become anyone.
  it("rejects a token whose payload was edited", () => {
    const [, mac] = signToken({ sub: "gh:1", login: "alice" }, 60).split(".");
    const forged = Buffer.from(JSON.stringify({ sub: "gh:2", login: "mallory", exp: 9_999_999_999 })).toString("base64url");
    expect(verifyToken(`${forged}.${mac}`)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyToken("")).toBeNull();
    expect(verifyToken("abc")).toBeNull();
    expect(verifyToken("a.b.c")).toBeNull();
  });

  it("rejects a token signed with a different APP_SECRET", () => {
    const token = signToken({ sub: "gh:1" }, 60);
    const original = process.env.APP_SECRET;
    process.env.APP_SECRET = "a-completely-different-secret-0123456789abcdef";
    try {
      expect(verifyToken(token)).toBeNull();
    } finally {
      process.env.APP_SECRET = original;
    }
  });
});

describe("secret encryption", () => {
  it("round-trips with the same context and never stores plaintext", () => {
    const enc = encryptSecret("sk-live-123456", "gh:1\0openai");
    expect(JSON.stringify(enc)).not.toContain("sk-live-123456");
    expect(decryptSecret(enc, "gh:1\0openai")).toBe("sk-live-123456");
  });

  // A stored key moved onto another user's record must not decrypt as theirs.
  it("fails to decrypt under another user or key name", () => {
    const enc = encryptSecret("sk-live-123456", "gh:1\0openai");
    expect(() => decryptSecret(enc, "gh:2\0openai")).toThrow();
    expect(() => decryptSecret(enc, "gh:1\0anthropic")).toThrow();
  });

  it("fails to decrypt tampered ciphertext", () => {
    const enc = encryptSecret("sk-live-123456", "ctx");
    const data = Buffer.from(enc.data, "base64url");
    data[0] ^= 0xff;
    expect(() => decryptSecret({ ...enc, data: data.toString("base64url") }, "ctx")).toThrow();
  });
});
