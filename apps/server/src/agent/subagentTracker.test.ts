import { describe, expect, it } from "vitest";
import * as z from "zod";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { Command, MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, StateBackend } from "deepagents";
import { SubagentTracker } from "./subagentTracker.js";

/** Replies by looking at the conversation it is handed, so the main agent and parallel subagents can share it. */
class ReactiveModel extends BaseChatModel {
  constructor(private readonly reply: (task: string, toolResults: string[]) => AIMessage) {
    super({});
  }

  _llmType() {
    return "reactive";
  }

  bindTools() {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const task = String(messages.find((m) => m.getType() === "human")?.content ?? "");
    const results = messages.filter((m) => m.getType() === "tool").map((m) => String(m.content));
    const message = this.reply(task, results);
    return { generations: [{ text: String(message.content), message }] };
  }
}

const calls = (...list: Array<[string, string, Record<string, unknown>]>) =>
  new AIMessage({ content: "", tool_calls: list.map(([id, name, args]) => ({ id, name, type: "tool_call" as const, args })) });

const lookup = tool(async ({ path }) => `contents of ${path}`, { name: "lookup", description: "look", schema: z.object({ path: z.string() }) });

/** The main agent sends "convert A" and "convert B" to two subagents at once, plus one tool of its own. */
function build(subagentStep: (task: string) => AIMessage, interruptOn?: Record<string, boolean>) {
  const model = new ReactiveModel((task, results) => {
    if (task === "go") {
      if (results.length > 0) return new AIMessage("main done");
      return calls(
        ["call_A", "task", { description: "convert A", subagent_type: "converter" }],
        ["call_B", "task", { description: "convert B", subagent_type: "verifier" }],
        ["call_main", "lookup", { path: "/main.ts" }]
      );
    }
    return results.length > 0 ? new AIMessage(`${task}: finished`) : subagentStep(task);
  });
  return createDeepAgent({
    model,
    tools: [lookup],
    backend: new StateBackend(),
    checkpointer: new MemorySaver(),
    subagents: [
      { name: "converter", description: "converts", systemPrompt: "convert" },
      { name: "verifier", description: "verifies", systemPrompt: "verify" },
    ],
    interruptOn,
  });
}

async function events(agent: ReturnType<typeof build>, input: unknown, threadId: string) {
  const tracker = new SubagentTracker();
  const out: unknown[] = [];
  const stream = await agent.stream(input as never, {
    streamMode: ["updates", "tasks"],
    subgraphs: true,
    configurable: { thread_id: threadId },
  } as never);
  for await (const [namespace, mode, payload] of stream as unknown as AsyncIterable<[string[], string, never]>) {
    out.push(...(mode === "tasks" ? tracker.onTask(namespace, payload) : tracker.onUpdate(namespace, payload)));
  }
  return out;
}

const forId = (list: unknown[], id: string) => list.filter((e) => (e as { id: string }).id === id);

describe("SubagentTracker", () => {
  it("follows parallel subagents separately, each under its own task call", async () => {
    const agent = build((task) => calls([`r${task}`, "lookup", { path: `/${task.split(" ")[1]}.ts` }]));
    const list = await events(agent, { messages: [{ role: "user", content: "go" }] }, "parallel");

    expect(forId(list, "call_A")).toEqual([
      { type: "subagent_start", id: "call_A", subagent: "converter", description: "convert A" },
      { type: "subagent_activity", id: "call_A", tool: "lookup", target: "/A.ts" },
      { type: "subagent_end", id: "call_A", status: "done" },
    ]);
    expect(forId(list, "call_B")).toEqual([
      { type: "subagent_start", id: "call_B", subagent: "verifier", description: "convert B" },
      { type: "subagent_activity", id: "call_B", tool: "lookup", target: "/B.ts" },
      { type: "subagent_end", id: "call_B", status: "done" },
    ]);
    // The main agent's own tool call is not a subagent.
    expect(forId(list, "call_main")).toEqual([]);
  });

  it("reports a subagent paused on an approval as waiting, then picks it up again on resume", async () => {
    const agent = build((task) => calls([`w${task}`, "write_file", { file_path: `/${task.split(" ")[1]}.ts`, content: "x" }]), { write_file: true });
    const paused = await events(agent, { messages: [{ role: "user", content: "go" }] }, "approval");
    expect(forId(paused, "call_A").at(-1)).toEqual({ type: "subagent_end", id: "call_A", status: "waiting" });

    const resumed = await events(agent, new Command({ resume: { decisions: [{ type: "approve" }] } }), "approval");
    expect(forId(resumed, "call_A")).toEqual([
      { type: "subagent_start", id: "call_A", subagent: "converter", description: "convert A" },
      { type: "subagent_end", id: "call_A", status: "done" },
    ]);
  });

  it("reports a failed subagent", () => {
    const tracker = new SubagentTracker();
    tracker.onTask([], { id: "step1", name: "tools", input: { lg_tool_call: { id: "call_X", name: "task", args: { subagent_type: "fixer", description: "fix" } } } });
    expect(tracker.onTask([], { id: "step1", name: "tools", error: "boom", interrupts: [] })).toEqual([
      { type: "subagent_end", id: "call_X", status: "failed" },
    ]);
  });

  it("shortens a long target to one line", () => {
    const tracker = new SubagentTracker();
    tracker.onTask([], { id: "s", name: "tools", input: { lg_tool_call: { id: "c", name: "task", args: {} } } });
    const [activity] = tracker.onUpdate(["tools:s"], {
      model_request: { messages: [{ tool_calls: [{ name: "execute", args: { command: `npm test\n${"x".repeat(300)}` } }] }] },
    }) as Array<{ target: string }>;
    expect(activity.target).not.toContain("\n");
    expect(activity.target.length).toBeLessThanOrEqual(161);
  });
});
