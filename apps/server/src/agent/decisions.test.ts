import { describe, expect, it } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { Command, MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, StateBackend } from "deepagents";
import { MAX_REASON_CHARS, rejectionMessage, toResumeDecisions } from "./decisions.js";

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

describe("toResumeDecisions", () => {
  it("wraps the user's reason in the message the model reads", () => {
    const [decision] = toResumeDecisions([{ type: "reject", reason: "  keep the old names  " }]);
    expect(decision).toEqual({ type: "reject", message: rejectionMessage("keep the old names") });
    expect(rejectionMessage("keep the old names")).toContain("Their reason:\nkeep the old names");
  });

  it("tells the model not to retry when no reason is given", () => {
    for (const reason of [undefined, "", "   "]) {
      const [decision] = toResumeDecisions([{ type: "reject", reason }]);
      expect(decision).toEqual({ type: "reject", message: rejectionMessage() });
    }
    expect(rejectionMessage()).toContain("Do not retry it unchanged");
  });

  it("passes approvals and edits through", () => {
    const edit = { type: "edit", editedAction: { name: "write_file", args: { file_path: "/a", content: "b" } } };
    expect(toResumeDecisions([{ type: "approve" }, edit])).toEqual([{ type: "approve" }, edit]);
  });

  it.each([
    ["not an array", { type: "approve" }],
    ["empty", []],
    ["unknown type", [{ type: "respond" }]],
    ["null entry", [null]],
    ["non-string reason", [{ type: "reject", reason: 42 }]],
    ["edit without args", [{ type: "edit", editedAction: { name: "write_file" } }]],
    ["edit with array args", [{ type: "edit", editedAction: { name: "write_file", args: [] } }]],
  ])("refuses %s", (_label, input) => {
    expect(() => toResumeDecisions(input)).toThrow("Invalid approval response.");
  });

  it("refuses a reason past the limit", () => {
    expect(() => toResumeDecisions([{ type: "reject", reason: "x".repeat(MAX_REASON_CHARS + 1) }])).toThrow(/too long/);
  });
});

describe("denying with a reason", () => {
  it("reaches the subagent that asked, and the action does not run", async () => {
    const model = new ScriptedModel([
      call("task", { description: "convert it", subagent_type: "converter" }),
      call("write_file", { file_path: "/a.ts", content: "renamed()" }),
    ]);
    const agent = createDeepAgent({
      model,
      backend: new StateBackend(),
      checkpointer: new MemorySaver(),
      subagents: [{ name: "converter", description: "converts", systemPrompt: "convert" }],
      interruptOn: { write_file: true },
    });
    const config = { configurable: { thread_id: "deny" } };

    const paused = (await agent.invoke({ messages: [{ role: "user", content: "go" }] }, config)) as { __interrupt__?: unknown[] };
    expect(paused.__interrupt__?.length).toBe(1);

    const decisions = toResumeDecisions([{ type: "reject", reason: "keep the old function names" }]);
    const result = (await agent.invoke(new Command({ resume: { decisions } }), config)) as { files?: Record<string, unknown> };

    // Call 3 is the subagent's model, right after the denial.
    const seen = model.calls[2].filter((m) => m.getType() === "tool").map((m) => String(m.content));
    expect(seen).toContain(rejectionMessage("keep the old function names"));
    expect(result.files?.["/a.ts"]).toBeUndefined();
  });
});
