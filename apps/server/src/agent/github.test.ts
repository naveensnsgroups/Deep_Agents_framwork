import { describe, expect, it } from "vitest";
import * as z from "zod";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { Command, MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, StateBackend } from "deepagents";
import { githubApprovals, isReadOnlyTool } from "./github.js";

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

const call = (id: string, name: string, args: Record<string, unknown>) =>
  new AIMessage({ content: "", tool_calls: [{ id, name, type: "tool_call", args }] });

/** Shaped like a tool from @langchain/mcp-adapters: the server's own label at metadata.annotations. */
function mcpTool(name: string, annotations?: Record<string, unknown>) {
  const state = { calls: 0 };
  const instance = tool(
    async () => {
      state.calls++;
      return `${name} ran`;
    },
    { name, description: name, schema: z.object({}), metadata: annotations ? { annotations } : undefined }
  );
  return { instance, state };
}

describe("isReadOnlyTool", () => {
  it("goes by the server's own label when there is one", () => {
    expect(isReadOnlyTool(mcpTool("get_file_contents", { readOnlyHint: true }).instance)).toBe(true);
    // A read-sounding name does not outweigh a server saying the tool acts.
    expect(isReadOnlyTool(mcpTool("get_and_close_issue", { readOnlyHint: false }).instance)).toBe(false);
    expect(isReadOnlyTool(mcpTool("push_files", { readOnlyHint: false, destructiveHint: true }).instance)).toBe(false);
  });

  it("falls back to the name only when the server labels nothing, and counts the unknown as acting", () => {
    expect(isReadOnlyTool(mcpTool("list_issues").instance)).toBe(true);
    expect(isReadOnlyTool(mcpTool("merge_pull_request").instance)).toBe(false);
    expect(isReadOnlyTool(mcpTool("do_something").instance)).toBe(false);
  });
});

describe("GitHub tools that act", () => {
  function build(steps: (task: string) => AIMessage) {
    const push = mcpTool("push_files", { readOnlyHint: false });
    const read = mcpTool("get_file_contents", { readOnlyHint: true });
    const tools = [push.instance, read.instance];
    const model = new ReactiveModel((task, results) => (results.length > 0 ? new AIMessage("done") : steps(task)));
    const agent = createDeepAgent({
      model,
      tools,
      backend: new StateBackend(),
      checkpointer: new MemorySaver(),
      subagents: [{ name: "helper", description: "helps", systemPrompt: "help" }],
      interruptOn: githubApprovals(tools),
    });
    return { agent, push, read };
  }

  it("stop for approval and do not run on a denial", async () => {
    const { agent, push } = build(() => call("p", "push_files", {}));
    const config = { configurable: { thread_id: "push" } };

    const paused = (await agent.invoke({ messages: [{ role: "user", content: "go" }] }, config)) as { __interrupt__?: unknown[] };
    expect(paused.__interrupt__?.length).toBe(1);
    expect(push.state.calls).toBe(0);

    await agent.invoke(new Command({ resume: { decisions: [{ type: "reject" }] } }), config);
    expect(push.state.calls).toBe(0);
  });

  it("stop for approval inside a subagent too", async () => {
    const { agent, push } = build((task) =>
      task === "go" ? call("t", "task", { description: "publish", subagent_type: "helper" }) : call("p", "push_files", {})
    );
    const paused = (await agent.invoke({ messages: [{ role: "user", content: "go" }] }, { configurable: { thread_id: "sub" } })) as {
      __interrupt__?: unknown[];
    };
    expect(paused.__interrupt__?.length).toBe(1);
    expect(push.state.calls).toBe(0);
  });

  it("while reading runs without asking", async () => {
    const { agent, read } = build(() => call("r", "get_file_contents", {}));
    const result = (await agent.invoke({ messages: [{ role: "user", content: "go" }] }, { configurable: { thread_id: "read" } })) as {
      __interrupt__?: unknown[];
    };
    expect(result.__interrupt__).toBeUndefined();
    expect(read.state.calls).toBe(1);
  });
});
