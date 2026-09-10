import { Router } from "express";
import type { ProviderOption } from "@deepagents-ide/shared";

/**
 * Default model names are suggestions the UI pre-fills — the user can type any model
 * name their key has access to. `serverKey` reports only whether a key exists in the
 * server env, never the key itself.
 */
export function providersRouter() {
  const router = Router();

  router.get("/providers", (_req, res) => {
    const providers: ProviderOption[] = [
      {
        id: "anthropic",
        label: "Anthropic Claude",
        defaultModel: process.env.ANTHROPIC_MODEL?.split(":").pop() ?? "claude-sonnet-4-6",
        serverKey: Boolean(process.env.ANTHROPIC_API_KEY),
        keyPlaceholder: "sk-ant-…",
      },
      {
        id: "google-genai",
        label: "Google Gemini",
        defaultModel: process.env.GOOGLE_MODEL?.split(":").pop() ?? "gemini-3.5-flash-lite",
        serverKey: Boolean(process.env.GOOGLE_API_KEY),
        keyPlaceholder: "AIza…",
      },
      {
        id: "openai",
        label: "OpenAI",
        defaultModel: process.env.OPENAI_MODEL?.split(":").pop() ?? "gpt-5.5",
        serverKey: Boolean(process.env.OPENAI_API_KEY),
        keyPlaceholder: "sk-…",
      },
      {
        id: "openrouter",
        label: "OpenRouter",
        // Model id format is OpenRouter's own, e.g. "anthropic/claude-sonnet-4.6" or
        // "z-ai/glm-5.2" — whatever the user's OpenRouter account has access to.
        defaultModel: process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-4.6",
        serverKey: Boolean(process.env.OPENROUTER_API_KEY),
        keyPlaceholder: "sk-or-…",
      },
    ];
    res.json({ providers });
  });

  return router;
}
