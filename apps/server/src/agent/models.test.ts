import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissingApiKeyError, resolveModel } from "./models.js";

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-server-key";
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
});

function apiKeyOf(model: unknown): string | undefined {
  const m = model as { apiKey?: string; openAIApiKey?: string };
  return m.apiKey ?? m.openAIApiKey;
}

describe("resolveModel without server keys", () => {
  // Under GitHub login a user without a key must be stopped, not quietly billed to the server.
  it("refuses to fall back to the server's key", () => {
    expect(() => resolveModel("openai:gpt-5.5", undefined, false)).toThrow(MissingApiKeyError);
  });

  it("uses the user's key", () => {
    expect(apiKeyOf(resolveModel("openai:gpt-5.5", "sk-user-key", false))).toBe("sk-user-key");
  });

  // A bare id is resolved by LangChain from the environment, bypassing the check entirely.
  it("rejects model ids without a known provider", () => {
    expect(() => resolveModel("gpt-5.5", "sk-user-key", false)).toThrow(MissingApiKeyError);
  });

  it("still falls back to the server key when server keys are allowed", () => {
    expect(apiKeyOf(resolveModel("openai:gpt-5.5"))).toBe("sk-server-key");
  });
});
