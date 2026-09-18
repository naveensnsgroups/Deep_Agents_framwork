import { Router } from "express";
import type { ProviderOption } from "@deepagents-ide/shared";
import { authMode, currentUser } from "../auth.js";
import { listUserKeys } from "../userSecrets.js";

/**
 * Default model names are suggestions the UI pre-fills — the user can type any model
 * name their key has access to. `serverKey` reports only whether a key exists in the
 * server env, never the key itself.
 */
export function providersRouter() {
  const router = Router();

  router.get("/providers", async (_req, res) => {
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
    // Under GitHub login the server's own keys are never used for anyone, so they are not
    // offered; what matters instead is whether this user has saved their own.
    if (authMode() === "oauth") {
      const { keys } = await listUserKeys(currentUser(res).id);
      for (const provider of providers) {
        provider.serverKey = false;
        provider.userKey = keys.some((k) => k.name === provider.id && k.saved);
      }
    }
    res.json({ providers });
  });

  return router;
}
