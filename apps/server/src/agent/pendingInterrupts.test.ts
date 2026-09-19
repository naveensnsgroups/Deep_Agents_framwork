import { describe, expect, it } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { Command, MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, StateBackend } from "deepagents";
import { askUserTool, MAX_ANSWER_CHARS } from "./askUser.js";
import { rejectionMessage } from "./decisions.js";
import { AnswerCollector, NOT_WAITING, pendingInterrupts, type PendingInterrupt } from "./pendingInterrupts.js";
import { toolFailureMiddleware } from "./toolFailures.js";

/** Replies by looking at the conversation it is handed, so the main agent and parallel subagents can share it. */
class ReactiveModel extends BaseChatModel {
  readonly calls: BaseMessage[][] = [];

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
    this.calls.push(messages);
    const task = String(messages.find((m) => m.getType() === "human")?.content ?? "");
    const results = messages.filter((m) => m.getType() === "tool").map((m) => String(m.content));
    const message = this.reply(task, results);
    return { generations: [{ text: String(message.content), message }] };
  }
}

const calls = (...list: Array<[string, string, Record<string, unknown>]>) =>
  new AIMessage({ content: "", tool_calls: list.map(([id, name, args]) => ({ id, name, type: "tool_call" as const, args })) });

/** The main agent sends A and B to two subagents at once; each subagent then makes `subagentCall`. */
function parallelSubagents(subagentCall: (task: string) => AIMessage, interruptOn?: Record<string, boolean>) {
  const model = new ReactiveModel((task, results) => {
    if (task === "go") {
      if (results.length > 0) return new AIMessage("main done");
      return calls(["t1", "task", { description: "A", subagent_type: "helper" }], ["t2", "task", { description: "B", subagent_type: "helper" }]);
    }
    return results.length > 0 ? new AIMessage(`${task}: ${results.join(" | ")}`) : subagentCall(task);
  });
  const agent = createDeepAgent({
    model,
    tools: [askUserTool],
    backend: new StateBackend(),
    checkpointer: new MemorySaver(),
    subagents: [{ name: "helper", description: "helps", systemPrompt: "help" }],
    interruptOn,
    middleware: toolFailureMiddleware(),
  });
  return { agent, model };
}

async function pausedOn(agent: ReturnType<typeof parallelSubagents>["agent"], threadId: string) {
  const config = { configurable: { thread_id: threadId } };
  await agent.invoke({ messages: [{ role: "user", content: "go" }] }, config);
  const pending = pendingInterrupts((await agent.getState(config)) as never);
  return { config, pending };
}

function subagentResults(messages: BaseMessage[]): string[] {
  return messages.filter((m) => m.getType() === "tool" && m.name === "task").map((m) => String(m.content));
}

describe("pending interrupts", () => {
  // Regression: one plain resume value answered every pending interrupt, so approving the one
  // card on screen also wrote the parallel subagent's file, which the user never saw.
  it("answers parallel approvals separately — approving one never approves the other", async () => {
    const { agent } = parallelSubagents((task) => calls([`w${task}`, "write_file", { file_path: `/${task}.txt`, content: task }]), {
      write_file: true,
    });
    const { config, pending } = await pausedOn(agent, "parallel-approvals");

    expect(pending.map((p) => p.kind)).toEqual(["approval", "approval"]);
    const pathOf = (p: PendingInterrupt) => (p.kind === "approval" ? p.actionRequests[0].args.file_path : undefined);
    const a = pending.find((p) => pathOf(p) === "/A.txt")!;
    const b = pending.find((p) => pathOf(p) === "/B.txt")!;

    const collector = new AnswerCollector(pending);
    expect(collector.record({ type: "resume_decisions", interruptId: a.id, decisions: [{ type: "approve" }] })).toBeUndefined();
    const resume = collector.record({ type: "resume_decisions", interruptId: b.id, decisions: [{ type: "reject", reason: "not B" }] });
    expect(resume).toBeDefined();

    const result = (await agent.invoke(new Command({ resume }), config)) as { files?: Record<string, unknown> };
    expect(result.files?.["/A.txt"]).toBeDefined();
    expect(result.files?.["/B.txt"]).toBeUndefined();
  });

  it("carries each subagent's own answer back to it", async () => {
    const { agent } = parallelSubagents((task) => calls([`q${task}`, "ask_user", { question: `Which version for ${task}?`, options: ["18", "19"] }]));
    const { config, pending } = await pausedOn(agent, "parallel-questions");

    expect(pending).toHaveLength(2);
    const collector = new AnswerCollector(pending);
    let resume: Record<string, unknown> | undefined;
    for (const p of pending) {
      expect(p.kind).toBe("question");
      if (p.kind !== "question") continue;
      expect(p.options).toEqual(["18", "19"]);
      resume = collector.record({ type: "answer_question", interruptId: p.id, answer: p.question.endsWith("A?") ? "React 18" : "React 19" });
    }

    const result = (await agent.invoke(new Command({ resume }), config)) as { messages: BaseMessage[] };
    expect(subagentResults(result.messages).sort()).toEqual([
      "A: The user answered:\nReact 18",
      "B: The user answered:\nReact 19",
    ]);
  });

  it("gives the denial reason to the subagent that asked", async () => {
    const { agent, model } = parallelSubagents((task) => calls([`w${task}`, "write_file", { file_path: `/${task}.txt`, content: task }]), {
      write_file: true,
    });
    const { config, pending } = await pausedOn(agent, "deny-reason");
    const collector = new AnswerCollector(pending);
    let resume: Record<string, unknown> | undefined;
    for (const p of pending) resume = collector.record({ type: "resume_decisions", interruptId: p.id, decisions: [{ type: "reject", reason: "keep names" }] });

    await agent.invoke(new Command({ resume }), config);
    const seen = model.calls.flat().filter((m) => m.getType() === "tool").map((m) => String(m.content));
    expect(seen.filter((c) => c === rejectionMessage("keep names"))).toHaveLength(2);
  });
});

describe("AnswerCollector", () => {
  const approval: PendingInterrupt = {
    id: "i1",
    kind: "approval",
    actionRequests: [{ name: "write_file", args: {} }],
    reviewConfigs: [{ actionName: "write_file", allowedDecisions: ["approve", "reject"] }],
  };
  const question: PendingInterrupt = { id: "i2", kind: "question", question: "Which?", options: [] };

  it("refuses an answer to something that is not waiting", () => {
    const collector = new AnswerCollector([approval, question]);
    expect(() => collector.record({ type: "answer_question", interruptId: "gone", answer: "x" })).toThrow(NOT_WAITING);
    expect(() => collector.record({ type: "answer_question", interruptId: "i1", answer: "x" })).toThrow(NOT_WAITING);
    expect(() => collector.record({ type: "resume_decisions", interruptId: "i2", decisions: [{ type: "approve" }] })).toThrow(NOT_WAITING);
  });

  it("refuses a decision count that does not match the actions", () => {
    const collector = new AnswerCollector([approval]);
    expect(() =>
      collector.record({ type: "resume_decisions", interruptId: "i1", decisions: [{ type: "approve" }, { type: "approve" }] })
    ).toThrow("Invalid approval response.");
  });

  it("refuses an empty or oversized answer", () => {
    const collector = new AnswerCollector([question]);
    expect(() => collector.record({ type: "answer_question", interruptId: "i2", answer: "   " })).toThrow(/empty/);
    expect(() => collector.record({ type: "answer_question", interruptId: "i2", answer: "x".repeat(MAX_ANSWER_CHARS + 1) })).toThrow(/too long/);
  });

  it("resumes once everything is answered, keyed by id, then waits on nothing", () => {
    const collector = new AnswerCollector([approval, question]);
    expect(collector.record({ type: "answer_question", interruptId: "i2", answer: " React 19 " })).toBeUndefined();
    expect(collector.record({ type: "resume_decisions", interruptId: "i1", decisions: [{ type: "approve" }] })).toEqual({
      i1: { decisions: [{ type: "approve" }] },
      i2: { answer: "React 19" },
    });
    expect(collector.waiting).toEqual([]);
  });
});
