import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { createMiddleware } from "langchain";

/**
 * Declines requests that have nothing to do with software before any model call happens.
 *
 * The system prompt is the primary scope control and handles nearly everything — models
 * follow a clear scope statement well. This exists for the cases a prompt cannot cover: it
 * costs nothing when it does not fire, and it fires before a token is spent, so an off-topic
 * request cannot consume the user's API quota at all.
 *
 * Deliberately **not** an LLM classifier. Classifying every turn would add a model call and
 * real latency to the common case, which is a developer asking about their own code; and a
 * classifier that is wrong blocks legitimate work, which is far more damaging here than
 * letting an occasional off-topic question through to the system prompt behind it.
 */

/**
 * Any of these means the message is about software, and the guardrail stands down — checked
 * first, so a request that mentions code is never blocked regardless of what else it says.
 * "Migrate the patient-records API" must reach the agent; it is a real migration task whose
 * vocabulary happens to be medical.
 */
const SOFTWARE_SIGNAL = new RegExp(
  [
    "```|`[^`]+`", // fenced or inline code
    "\\.(ts|tsx|js|jsx|py|java|go|rs|rb|php|cs|sql|json|ya?ml|toml|env|md|sh|dockerfile)\\b",
    "[\\\\/][\\w.-]+[\\\\/]", // a path fragment
    "\\b(code|codebase|repo|repository|function|method|class|module|package|import|dependency|dependencies)\\b",
    "\\b(migrat\\w*|convert|refactor|port|rewrite|translate)\\b",
    "\\b(bug|error|exception|stack ?trace|traceback|fails?|failing|crash\\w*|debug)\\b",
    "\\b(test|tests|testing|pytest|jest|build|compile|typecheck|lint|deploy)\\b",
    "\\b(api|endpoint|route|schema|database|query|migration|config|server|backend|frontend)\\b",
    "\\b(express|fastapi|mongoose|pydantic|react|django|flask|node|python|typescript|javascript)\\b",
    "\\b(git|branch|commit|merge|pull request|pr)\\b",
    "\\b(file|files|directory|folder|line \\d+)\\b",
  ].join("|"),
  "i"
);

/**
 * Unambiguous non-software intents. Every entry names something this tool cannot sensibly be
 * asked for, and each is checked only after SOFTWARE_SIGNAL has already cleared — so "write a
 * poem" is declined while "write a poem generator in Python" is not.
 */
const OFF_TOPIC = new RegExp(
  [
    "\\b(recipe|cook|bake|ingredients?)\\b",
    "\\b(poem|poetry|sonnet|haiku|lyrics|short story|novel)\\b",
    "\\b(diagnos\\w*|symptoms?|prescription|medication|dosage)\\b",
    "\\b(lawsuit|legal advice|attorney|lawyer)\\b",
    "\\b(stock|stocks|invest\\w*|crypto|bitcoin|portfolio)\\b",
    "\\b(horoscope|astrology|zodiac)\\b",
    "\\b(essay|homework|assignment) (about|on)\\b",
    "\\bwho (won|is the president|is the prime minister)\\b",
    "\\b(weather|forecast) (today|tomorrow|in)\\b",
    "\\btranslate (this|the following) (text|paragraph|sentence)\\b",
  ].join("|"),
  "i"
);

const DECLINE =
  "I only work on software for the project you have open — migrating, reading, writing, " +
  "debugging, testing and explaining code. I can't help with that one. If it relates to the " +
  "codebase in a way I've missed, say so and I'll take another look.";

function textOf(message: BaseMessage): string {
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text ?? "") : ""))
    .join(" ");
}

/**
 * Only the newest human message is examined. Scanning the whole history would re-judge a
 * conversation that is already underway — and a follow-up like "why?" carries no software
 * signal of its own despite being entirely on topic.
 */
function latestUserText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const type = messages[i].getType();
    if (type === "human") return textOf(messages[i]);
    // Anything after the last human turn is the agent's own work, not a new request.
    if (type === "ai" || type === "tool") break;
  }
  return "";
}

export function isOffTopic(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (SOFTWARE_SIGNAL.test(trimmed)) return false;
  return OFF_TOPIC.test(trimmed);
}

export function scopeGuardrailMiddleware() {
  return createMiddleware({
    name: "scopeGuardrailMiddleware",
    beforeAgent: {
      // Required: a hook that returns `jumpTo` must declare the targets it may jump to, and
      // the graph rejects the jump at runtime otherwise ("Invalid jump target: end, no
      // beforeAgent.canJumpTo defined"). The middleware looked correct and unit-tested fine
      // without this, because the predicate is separable from the wiring — only an
      // end-to-end run surfaced it.
      canJumpTo: ["end"],
      hook: (state) => {
        const text = latestUserText(state.messages as BaseMessage[]);
        if (!isOffTopic(text)) return undefined; // pass through untouched

        // Ends the turn with this as the answer, without ever calling the model, so a
        // declined request costs nothing.
        return { messages: [new AIMessage(DECLINE)], jumpTo: "end" as const };
      },
    },
  });
}
