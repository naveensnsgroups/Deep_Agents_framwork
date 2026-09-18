import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import type { ModelId } from "@deepagents-ide/shared";

/**
 * Gemini's function-calling API rejects the JSON Schema Zod v4 emits for some of
 * deepagents' built-in tools (exclusiveMinimum, nullable type arrays — see
 * https://github.com/langchain-ai/langchainjs/issues/10956). There's no released
 * fix yet, so Gemini requests are routed through our own /gemini-proxy, which
 * repairs the schema in-flight before it reaches Google's API.
 */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  "google-genai": "Google Gemini",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

export function providerOf(model: ModelId): string {
  const separator = model.indexOf(":");
  return separator === -1 ? "" : model.slice(0, separator);
}

export class MissingApiKeyError extends Error {}

/**
 * `allowServerKeys: false` is the GitHub-login setting: each user runs on their own key, so the
 * server's environment keys must never be used on their behalf — not as a fallback when their
 * key is missing, and not through a bare model name that LangChain would resolve from the
 * environment by itself.
 */
export function resolveModel(model: ModelId, apiKey?: string, allowServerKeys = true) {
  const separator = model.indexOf(":");
  const provider = separator === -1 ? "" : model.slice(0, separator);
  const modelName = separator === -1 ? model : model.slice(separator + 1);

  if (!allowServerKeys) {
    if (!(provider in PROVIDER_LABELS)) throw new MissingApiKeyError(`Unsupported model "${model}".`);
    if (!apiKey) {
      throw new MissingApiKeyError(`No ${PROVIDER_LABELS[provider]} API key saved. Add yours in "My keys", or enter one when opening the workspace.`);
    }
  }

  if (provider === "google-genai") {
    const port = process.env.PORT ?? "4000";
    return new ChatGoogleGenerativeAI({
      model: modelName,
      apiKey: apiKey || process.env.GOOGLE_API_KEY,
      baseUrl: `http://localhost:${port}/gemini-proxy`,
    });
  }
  if (provider === "anthropic") {
    return new ChatAnthropic({ model: modelName, apiKey: apiKey || process.env.ANTHROPIC_API_KEY });
  }
  if (provider === "openai") {
    return new ChatOpenAI({ model: modelName, apiKey: apiKey || process.env.OPENAI_API_KEY });
  }
  if (provider === "openrouter") {
    // OpenRouter has no dedicated LangChain client — it's an OpenAI-compatible proxy in
    // front of many providers, so ChatOpenAI works as-is once pointed at OpenRouter's
    // base URL. Model names are OpenRouter's own namespaced ids (e.g.
    // "anthropic/claude-sonnet-4.6", "z-ai/glm-5.2"), passed straight through unchanged.
    return new ChatOpenAI({
      model: modelName,
      apiKey: apiKey || process.env.OPENROUTER_API_KEY,
      configuration: { baseURL: "https://openrouter.ai/api/v1" },
    });
  }
  return model;
}
