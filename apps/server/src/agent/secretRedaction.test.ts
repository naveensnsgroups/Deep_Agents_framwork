import { describe, expect, it } from "vitest";
import { redactForTest } from "./secretRedaction.js";

/**
 * The cost of a false negative here is a live credential sent to a third-party model. The
 * cost of a false positive is corrupted source code, so the "left alone" cases matter just
 * as much as the "redacted" ones.
 */
describe("secret redaction", () => {
  it("redacts provider API keys", () => {
    const out = redactForTest("ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
    expect(out).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
    expect(out).toContain("ANTHROPIC_API_KEY=");
  });

  it("redacts Google and E2B keys", () => {
    expect(redactForTest("key: AIzaSyD-1234567890abcdefghijklmnopqrstu")).not.toContain("AIzaSyD-1234567890abcdefghijklmnopqrstu");
    expect(redactForTest("E2B_API_KEY=e2b_0123456789abcdef0123456789abcdef01234567")).not.toContain("0123456789abcdef0123456789abcdef");
  });

  it("redacts GitHub tokens", () => {
    const token = "ghp_" + "a".repeat(36);
    expect(redactForTest(`token=${token}`)).not.toContain(token);
  });

  it("redacts AWS access key ids", () => {
    expect(redactForTest("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE")).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("redacts only the password from a connection string", () => {
    const out = redactForTest("mongodb://appuser:s3cr3tpassw0rd@cluster0.mongodb.net/orders");
    expect(out).not.toContain("s3cr3tpassw0rd");
    // The rest has to survive — the agent is migrating the code that builds this URI.
    expect(out).toContain("mongodb://");
    expect(out).toContain("appuser");
    expect(out).toContain("cluster0.mongodb.net/orders");
  });

  it("redacts private key blocks and JWTs", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    expect(redactForTest(pem)).not.toContain("MIIEowIBAAKCAQEA");

    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
    expect(redactForTest(`Authorization: Bearer ${jwt}`)).not.toContain(jwt);
  });

  it("leaves ordinary source code untouched", () => {
    // Every one of these would be mangled by the built-in email/url/ip detectors, which is
    // why they are not used.
    for (const code of [
      'const API_URL = "https://api.example.com/v1/users";',
      '"author": "naveen@example.com"',
      'app.listen(4000, "127.0.0.1")',
      "const KEY = process.env.STRIPE_KEY;",
      'placeholder = "<set MONGO_URI in .env>"',
      "import { sk } from './sk-utils';",
      "mongodb://localhost:27017/testdb",
    ]) {
      expect(redactForTest(code), code).toBe(code);
    }
  });
});
