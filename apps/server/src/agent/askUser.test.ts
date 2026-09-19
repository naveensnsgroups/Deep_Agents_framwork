import { describe, expect, it } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { Command, MemorySaver } from "@langchain/langgraph";
import { createDeepAgent } from "deepagents";
import { askUserTool, MAX_OPTIONS } from "./askUser.js";
import { pendingInterrupts } from "./pendingInterrupts.js";

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

const ask = (args: Record<string, unknown>) =>
  new AIMessage({ content: "", tool_calls: [{ id: "call_ask", name: "ask_user", type: "tool_call", args }] });

async function askedWith(args: Record<string, unknown>) {
  const model = new ScriptedModel([ask(args)]);
  const agent = createDeepAgent({ model, tools: [askUserTool], checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: "ask" } };
  await agent.invoke({ messages: [{ role: "user", content: "go" }] }, config);
  const [pending] = pendingInterrupts((await agent.getState(config)) as never);
  return { agent, model, config, pending };
}

const lastToolResult = (messages: BaseMessage[]) => String(messages.filter((m) => m.getType() === "tool").at(-1)?.content);

describe("ask_user", () => {
  it("pauses with the question and continues with the answer", async () => {
    const { agent, model, config, pending } = await askedWith({ question: " Keep the old tests? ", options: [" Keep ", "Delete", ""] });
    expect(pending).toMatchObject({ kind: "question", question: "Keep the old tests?", options: ["Keep", "Delete"] });

    await agent.invoke(new Command({ resume: { [pending.id]: { answer: "Keep them" } } }), config);
    expect(lastToolResult(model.calls[1])).toBe("The user answered:\nKeep them");
  });

  it("offers at most the maximum number of options", async () => {
    const { pending } = await askedWith({ question: "Pick", options: ["1", "2", "3", "4", "5", "6", "7"] });
    expect(pending.kind === "question" && pending.options).toHaveLength(MAX_OPTIONS);
  });

  it("carries on with a stated assumption when resumed without an answer", async () => {
    const { agent, model, config } = await askedWith({ question: "Which?", options: [] });
    // What the eval runner does: it only knows how to reject approvals.
    await agent.invoke(new Command({ resume: { decisions: [{ type: "reject" }] } }), config);
    expect(lastToolResult(model.calls[1])).toMatch(/did not answer/);
  });
});
