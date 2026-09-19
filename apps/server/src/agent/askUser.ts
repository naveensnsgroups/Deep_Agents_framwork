import * as z from "zod";
import { tool } from "langchain";
import { interrupt } from "@langchain/langgraph";

export const ASK_USER_TOOL = "ask_user";

/** Suggested answers beyond this are dropped; a question with more choices is a form, not a question. */
export const MAX_OPTIONS = 5;
export const MAX_ANSWER_CHARS = 4000;

/** What the tool pauses the run with, and what the chat renders as a question card. */
export interface AskUserRequest {
  type: "ask_user";
  question: string;
  options: string[];
}

/** What a run resumes the tool with. */
export interface AskUserAnswer {
  answer: string;
}

export function isAskUserRequest(value: unknown): value is AskUserRequest {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "ask_user";
}

/**
 * Lets the agent — or any subagent, since they inherit the main agent's tools — stop and ask the
 * user something it cannot find out by reading the project, then carry on with the answer in the
 * same run. deepagents' docs describe a `respond` decision for this, but the installed langchain
 * (1.5.11) only supports approve, edit and reject, so the tool raises its own interrupt instead —
 * the pattern those docs show for interrupts inside a tool.
 *
 * On resume, LangGraph runs the tool again from the top and `interrupt()` returns the answer.
 */
export const askUserTool = tool(
  async ({ question, options }) => {
    const request: AskUserRequest = {
      type: "ask_user",
      question: question.trim(),
      options: options.map((o) => o.trim()).filter(Boolean).slice(0, MAX_OPTIONS),
    };
    const reply = interrupt(request) as Partial<AskUserAnswer> | undefined;
    const answer = typeof reply?.answer === "string" ? reply.answer.trim() : "";
    // Anything else means the run was resumed by something other than the user answering —
    // the eval runner, for one, only knows how to reject approvals.
    if (!answer) return "The user did not answer. Continue with your best judgement and state the assumption you made.";
    return `The user answered:\n${answer}`;
  },
  {
    name: ASK_USER_TOOL,
    description:
      "Ask the user a question and wait for the answer. Use only for a decision the project cannot tell you and that changes what you write — a target version, whether to keep something, which of two valid approaches. Do not ask what you can find out by reading files, and ask once rather than in several rounds. Offer the likely answers as options when there are a few.",
    // Plain types only — no .optional() or .max(), whose JSON Schema keywords Gemini rejects (see
    // routes/geminiProxy.ts). An empty list means no suggestions; the limit is applied above.
    schema: z.object({
      question: z.string().describe("One clear question, with the context needed to answer it."),
      options: z
        .array(z.string())
        .describe(`Up to ${MAX_OPTIONS} likely answers, or an empty list. The user can always type their own.`),
    }),
  }
);
