import { describe, expect, it } from "vitest";
import * as z from "zod";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, StateBackend } from "deepagents";
import { toolFailureMiddleware } from "./toolFailures.js";

class ScriptedModel extends BaseChatModel {
  readonly calls: BaseMessage[][] = [];

  constructor(private readonly script: AIMessage[]) {
    super({});
  }

  _llmType() {
    return "scripted";
  }

  bindTools() {
    return this;
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls.push(messages);
    const message = this.script[this.calls.length - 1] ?? new AIMessage("done");
    return { generations: [{ text: String(message.content), message }] };
  }
}

const call = (name: string, args: Record<string, unknown>) =>
  new AIMessage({ content: "", tool_calls: [{ id: `call_${name}`, name, type: "tool_call", args }] });

function toolResults(messages: BaseMessage[]): string {
  return messages
    .filter((m) => m.getType() === "tool")
    .map((m) => String(m.content))
    .join("\n");
}

/** A GitHub-style tool that fails the first `failures` times it is called. */
function flakyTool(name: string, failures: number) {
  const state = { calls: 0 };
  const instance = tool(
    async () => {
      state.calls++;
      if (state.calls <= failures) throw new Error(`upstream 502 on attempt ${state.calls}`);
      return "ok";
    },
    { name, description: name, schema: z.object({}) }
  );
  return { instance, state };
}

describe("tool failures", () => {
  // Regression: a retry around every tool caught the approval interrupt a subagent raises through
  // the `task` tool, re-ran the subagent, and the approval card never reached the user.
  it("lets a subagent's approval request reach the user", async () => {
    const model = new ScriptedModel([
      call("task", { description: "write it", subagent_type: "writer" }),
      call("write_file", { file_path: "/a.txt", content: "x" }),
    ]);
    const agent = createDeepAgent({
      model,
      backend: new StateBackend(),
      checkpointer: new MemorySaver(),
      subagents: [{ name: "writer", description: "writes", systemPrompt: "write" }],
      interruptOn: { write_file: true },
      middleware: toolFailureMiddleware(),
    });

    const result = (await agent.invoke(
      { messages: [{ role: "user", content: "go" }] },
      { configurable: { thread_id: "approval" } }
    )) as { __interrupt__?: unknown[] };

    expect(result.__interrupt__?.length).toBe(1);
    expect(model.calls).toHaveLength(2);
  });

  it("hands a thrown error back to the model with its real message, and the run goes on", async () => {
    const { instance } = flakyTool("push_files", 5);
    const model = new ScriptedModel([call("push_files", {}), new AIMessage("recovered")]);
    const agent = createDeepAgent({ model, tools: [instance], middleware: toolFailureMiddleware([instance]) });

    const result = await agent.invoke({ messages: [{ role: "user", content: "go" }] });

    expect(toolResults(result.messages)).toContain("upstream 502 on attempt 1");
    expect(String(result.messages.at(-1)?.content)).toBe("recovered");
  });

  it("retries a read-only GitHub tool", async () => {
    const { instance, state } = flakyTool("get_file_contents", 1);
    const model = new ScriptedModel([call("get_file_contents", {}), new AIMessage("done")]);
    const agent = createDeepAgent({ model, tools: [instance], middleware: toolFailureMiddleware([instance]) });

    const result = await agent.invoke({ messages: [{ role: "user", content: "go" }] });

    expect(state.calls).toBe(2);
    expect(toolResults(result.messages)).toContain("ok");
  });

  it("never retries a tool that acts", async () => {
    const { instance, state } = flakyTool("create_pull_request", 1);
    const model = new ScriptedModel([call("create_pull_request", {}), new AIMessage("done")]);
    const agent = createDeepAgent({ model, tools: [instance], middleware: toolFailureMiddleware([instance]) });

    await agent.invoke({ messages: [{ role: "user", content: "go" }] });

    expect(state.calls).toBe(1);
  });
});
