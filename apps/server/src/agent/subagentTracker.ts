import type { ServerToClientMessage, SubagentStatus } from "@deepagents-ide/shared";

type SubagentEvent = Extract<ServerToClientMessage, { type: "subagent_start" | "subagent_activity" | "subagent_end" }>;

interface ToolCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

/** What LangGraph's "tasks" stream mode reports as a step starts, and again as it finishes. */
interface TaskEvent {
  id: string;
  name: string;
  input?: { lg_tool_call?: ToolCall };
  result?: unknown;
  error?: unknown;
  interrupts?: unknown[];
}

const MAX_TARGET_CHARS = 160;

/** The argument that says what a tool call is about: the file, the search, the command. */
function targetOf(args: Record<string, unknown> = {}): string | undefined {
  for (const key of ["file_path", "path", "pattern", "command", "question", "query"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      const text = value.trim().replace(/\s+/g, " ");
      return text.length > MAX_TARGET_CHARS ? `${text.slice(0, MAX_TARGET_CHARS)}…` : text;
    }
  }
  return undefined;
}

/**
 * Follows the subagents a run launches, for the live cards in the chat.
 *
 * A subagent's events arrive under a namespace naming the graph step it runs in
 * (`tools:<step id>`), which is not the id of the `task` call that launched it — deepagents' own
 * streaming docs match the two by guessing, which mixes up subagents running in parallel. The
 * "tasks" stream mode settles it: each tools step is reported as it starts with the one tool call
 * it executes (`lg_tool_call`), so step id → task call id is read, not guessed. Only the main
 * agent's steps are considered — subagents cannot launch subagents.
 */
export class SubagentTracker {
  /** Step id → the `task` call it runs. */
  private readonly running = new Map<string, string>();

  /** Called for each "tasks" stream event. */
  onTask(namespace: string[], event: TaskEvent): SubagentEvent[] {
    if (namespace.length !== 0 || event.name !== "tools") return [];

    const call = event.input?.lg_tool_call;
    if (call) {
      if (call.name !== "task" || !call.id) return [];
      this.running.set(event.id, call.id);
      return [
        {
          type: "subagent_start",
          id: call.id,
          subagent: String(call.args?.subagent_type ?? "subagent"),
          description: String(call.args?.description ?? ""),
        },
      ];
    }

    const id = this.running.get(event.id);
    if (!id) return [];
    this.running.delete(event.id);
    const status: SubagentStatus = event.interrupts && event.interrupts.length > 0 ? "waiting" : event.error ? "failed" : "done";
    return [{ type: "subagent_end", id, status }];
  }

  /** Called for each "updates" stream event: a subagent's model step names the tools it is about to use. */
  onUpdate(namespace: string[], update: Record<string, unknown>): SubagentEvent[] {
    const step = namespace[0]?.startsWith("tools:") ? namespace[0].slice("tools:".length) : undefined;
    const id = step && this.running.get(step);
    if (!id || !("model_request" in update)) return [];

    const messages = (update.model_request as { messages?: Array<{ tool_calls?: ToolCall[] }> } | undefined)?.messages ?? [];
    return messages.flatMap((m) =>
      (m.tool_calls ?? []).map((call): SubagentEvent => ({ type: "subagent_activity", id, tool: call.name ?? "tool", target: targetOf(call.args) }))
    );
  }
}
