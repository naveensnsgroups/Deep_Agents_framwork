import { createMiddleware } from "langchain";
import { HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

/**
 * Redacts live credentials before anything reaches a model provider.
 *
 * Every file the agent reads is transmitted to Anthropic, Google, OpenAI or OpenRouter, and
 * real repositories carry real secrets — a committed `.env`, a connection string in a test
 * fixture, an API key left as a default in a config file. `_shared.md` already forbids the
 * agent from *writing* a secret into source; this covers the other direction, which a prompt
 * cannot: the value leaving the machine in the first place.
 *
 * The built-in PII types are deliberately **not** used. `email`, `url`, `ip` and
 * `mac_address` occur constantly in ordinary source — a package.json author, a CORS origin,
 * a bound host, a docker-compose service — and redacting them would corrupt the code the
 * agent is trying to migrate. Only high-confidence credential shapes are matched, each one a
 * string with no legitimate reason to be read by a model.
 *
 * `redact` rather than `block`: the agent still needs to know a secret *exists* to migrate
 * the code that reads it. It never needs the value, and blocking would stall a migration on
 * the very file it was asked to convert.
 */
interface SecretPattern {
  /** Becomes the placeholder name, e.g. `[REDACTED_PROVIDER_API_KEY]`. */
  name: string;
  pattern: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    // Anthropic, OpenAI, OpenRouter, Google, E2B, Stripe live keys.
    name: "provider_api_key",
    pattern: /\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:live|test)-[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{32,}|sk-or-v1-[A-Za-z0-9]{32,}|AIza[A-Za-z0-9_-]{30,}|e2b_[A-Za-z0-9]{32,}|rk_live_[A-Za-z0-9]{20,})\b/g,
  },
  {
    // GitHub personal access, OAuth, app, and fine-grained tokens.
    name: "github_token",
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g,
  },
  {
    name: "aws_access_key",
    pattern: /\b((?:AKIA|ASIA|AGPA|AIPA|ANPA|AROA)[A-Z0-9]{16})\b/g,
  },
  {
    // Credentials embedded in a connection URI. Only the password is replaced, so the host,
    // port, database name and driver stay intact and the agent can still migrate the URI.
    name: "connection_string_password",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s:/@]{3,})@/gi,
  },
  {
    name: "private_key_block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
  {
    // JWTs: three base64url segments. Long enough to avoid colliding with ordinary
    // dotted identifiers in code.
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
];

/**
 * A capture group, when the pattern has one, narrows what gets replaced to the secret itself
 * — that is what lets a connection string keep everything except its password.
 */
function detectorFor({ pattern }: SecretPattern) {
  return (content: string) => {
    const matches: Array<{ text: string; start: number; end: number }> = [];
    // Cloned per call: a module-level /g regex carries `lastIndex` between calls, so a
    // shared instance would skip matches on every second invocation.
    const regex = new RegExp(pattern.source, pattern.flags);

    for (let m = regex.exec(content); m !== null; m = regex.exec(content)) {
      const secret = m.length > 2 ? m[2] : m.length > 1 ? m[1] : m[0];
      const start = m[0] === secret ? m.index : m.index + m[0].indexOf(secret);
      matches.push({ text: secret, start, end: start + secret.length });

      // A zero-length match would loop forever.
      if (m[0].length === 0) regex.lastIndex += 1;
    }
    return matches;
  };
}

/** Exposes the exact function the middleware uses, so tests exercise it rather than a copy. */
export function redactForTest(content: string): string {
  return redactText(content);
}

/** Applies every pattern to one string. Shared by the middleware, trace masking (tracing.ts) and redactForTest. */
export function redactText(content: string): string {
  return SECRET_PATTERNS.reduce((text, entry) => {
    const matches = detectorFor(entry)(text);
    if (matches.length === 0) return text;
    // Right to left, so each replacement cannot shift the offsets still pending.
    return [...matches]
      .sort((a, b) => b.start - a.start)
      .reduce((acc, m) => acc.slice(0, m.start) + `[REDACTED_${entry.name.toUpperCase()}]` + acc.slice(m.end), text);
  }, content);
}

/**
 * Rewrites message content in place, handling both shapes a message can carry.
 *
 * This is why `piiMiddleware` could not be used despite being built for exactly this job:
 * it does `String(message.content)`, and deepagents' filesystem tools return an array of
 * content blocks rather than a string. `String([{type:"text",…}])` is `"[object Object]"`,
 * so every pattern missed and redaction silently did nothing — the middleware ran, reported
 * no matches, and the secrets went to the model anyway. Verified against a real read_file
 * result before replacing it.
 */
function redactMessageContent(content: unknown): { content: unknown; changed: boolean } {
  if (typeof content === "string") {
    const next = redactText(content);
    return { content: next, changed: next !== content };
  }

  if (Array.isArray(content)) {
    let changed = false;
    const next = content.map((block) => {
      if (block && typeof block === "object" && "text" in block && typeof (block as { text: unknown }).text === "string") {
        const original = (block as { text: string }).text;
        const redacted = redactText(original);
        if (redacted !== original) {
          changed = true;
          return { ...block, text: redacted };
        }
      }
      return block;
    });
    return { content: changed ? next : content, changed };
  }

  return { content, changed: false };
}

/**
 * Scrubs credentials out of tool results and user input before each model call.
 *
 * Tool results are the main exposure — that is how file contents enter the context — and the
 * newest human message covers a user pasting a key into the chat. Assistant output is left
 * alone deliberately: a redaction pass over content the agent is composing risks mangling
 * code it is writing, and files are written through tool arguments rather than message text.
 */
export function secretRedactionMiddleware() {
  return createMiddleware({
    name: "secretRedactionMiddleware",
    beforeModel: (state) => {
      const messages = (state.messages ?? []) as BaseMessage[];
      if (messages.length === 0) return undefined;

      let changed = false;
      const next = messages.map((message) => {
        const type = message.getType();
        if (type !== "tool" && type !== "human") return message;

        const result = redactMessageContent(message.content);
        if (!result.changed) return message;
        changed = true;

        // Rebuilt rather than mutated: LangGraph compares messages by identity when merging
        // state, so an in-place edit would not be persisted.
        if (type === "tool") {
          const tool = message as ToolMessage;
          return new ToolMessage({
            content: result.content as string,
            id: tool.id,
            name: tool.name,
            tool_call_id: tool.tool_call_id,
            status: tool.status,
          });
        }
        return new HumanMessage({ content: result.content as string, id: message.id, name: message.name });
      });

      return changed ? { messages: next } : undefined;
    },
  });
}
