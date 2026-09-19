import { isGraphBubbleUp } from "@langchain/langgraph";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { toolErrorMiddleware, toolRetryMiddleware, type AgentMiddleware } from "langchain";
import { isReadOnlyTool } from "./github.js";

/** Long enough for a stack-free error explanation, short enough not to flood the context. */
const MAX_ERROR_CHARS = 2000;


/**
 * The real message, not just the error's type. `toolRetryMiddleware`'s own failure text reports
 * only the class name ("failed … with ToolException"), which left the model — and the person
 * reading the transcript — with no idea what went wrong.
 */
function describeError(error: unknown): string {
  const err = error instanceof Error ? error : new Error(String(error));
  const text = `${err.name}: ${err.message}`;
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

/**
 * How a failing tool is handled, for the main agent and every subagent.
 *
 * Every error becomes a tool result the model can react to, instead of ending the whole run.
 * LangGraph control flow — above all a subagent's approval interrupt, which travels up through
 * the `task` tool as a thrown signal — always passes through untouched. A retry wrapped around
 * every tool (toolRetryMiddleware's default) caught that signal as a failure and re-ran the
 * subagent, so its approval card never reached the user.
 *
 * Only read-only network tools are retried: a retried `get_file_contents` changes nothing, whereas
 * a retried `create_pull_request` or `push_files` could act twice. See isReadOnlyTool.
 */
export function toolFailureMiddleware(tools: StructuredToolInterface[] = []): AgentMiddleware[] {
  const retryable = tools.filter(isReadOnlyTool).map((t) => t.name);

  return [
    toolErrorMiddleware({ onError: (error) => describeError(error) }),
    // Placed after the error handler, so it retries first and hands a final failure back to it.
    ...(retryable.length > 0
      ? [
          toolRetryMiddleware({
            tools: retryable,
            maxRetries: 2,
            onFailure: "error",
            retryOn: (error) => !isGraphBubbleUp(error),
          }),
        ]
      : []),
  ];
}
