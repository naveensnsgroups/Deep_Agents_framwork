import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { tool } from "@langchain/core/tools";
import { createDeepAgent, StateBackend } from "deepagents";

// Built from parts so this file does not itself look like a leaked key to a scanner.
const SECRET = ["sk-ant-api03", "Q7fXk2LmN9pR4sT6vW8yZ1aB3cD5eF"].join("-");
const FILE_MARKER = "export const LEGACY_HANDLER_MARKER = true;";

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

/** A project file with a live-looking key in it, read by a subagent — the case masking exists for. */
const readEnv = tool(async () => `${FILE_MARKER}\nANTHROPIC_API_KEY=${SECRET}\n`, {
  name: "read_env",
  description: "reads .env",
  schema: z.object({}),
});

/** Every request body the LangSmith client sent, as text. */
let sent: string[];

async function bodyText(body: unknown, encoding?: string | null): Promise<string> {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (body instanceof ReadableStream) {
    // The client streams its multipart batches, compressed when it can.
    const stream = encoding === "gzip" || encoding === "deflate" ? body.pipeThrough(new DecompressionStream(encoding)) : body;
    return await new Response(stream).text();
  }
  if (body instanceof Uint8Array) return new TextDecoder().decode(body);
  if (body instanceof Blob) return await body.text();
  if (body instanceof FormData) {
    const parts: string[] = [];
    for (const [, value] of body.entries()) parts.push(typeof value === "string" ? value : await value.text());
    return parts.join("\n");
  }
  return String(body);
}

beforeEach(() => {
  sent = [];
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: { body?: unknown; headers?: HeadersInit }) => {
      sent.push(await bodyText(init?.body, new Headers(init?.headers).get("content-encoding")));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    })
  );
  vi.stubEnv("LANGSMITH_API_KEY", "lsv2_test_key");
  vi.stubEnv("LANGSMITH_ENDPOINT", "https://langsmith.invalid");
  vi.stubEnv("LANGSMITH_HIDE_INPUTS", "");
  vi.stubEnv("LANGSMITH_HIDE_OUTPUTS", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Runs the main agent, which delegates to a subagent that reads the file, with tracing as configured. */
async function tracedRun(): Promise<string> {
  const { traceConfig, flushTraces } = await import("./tracing.js");
  const model = new ReactiveModel((task, results) => {
    if (task === "go") return results.length ? new AIMessage("main done") : call("call_task", "task", { description: "check env", subagent_type: "helper" });
    return results.length ? new AIMessage("helper done") : call("call_read", "read_env", {});
  });
  const agent = createDeepAgent({
    model,
    tools: [readEnv],
    backend: new StateBackend(),
    subagents: [{ name: "helper", description: "helps", systemPrompt: "help" }],
  });
  await agent.invoke(
    { messages: [{ role: "user", content: "go" }] },
    {
      configurable: { thread_id: "thread-7f3a" },
      ...traceConfig({ userId: "gh:42", userLogin: "octocat", workspace: "https://github.com/o/r", model: "anthropic:claude-sonnet-5" }),
    }
  );
  await flushTraces();
  return sent.join("\n");
}

describe("tracing", () => {
  it("is off without the switch and a key, and sends nothing", async () => {
    vi.stubEnv("LANGSMITH_TRACING", "");
    const { traceConfig, describeTracing } = await import("./tracing.js");
    expect(traceConfig({ userId: "u", workspace: "w", model: "m" })).toEqual({});
    expect(describeTracing()).toBe("LangSmith tracing: off");

    vi.stubEnv("LANGSMITH_TRACING", "true");
    vi.stubEnv("LANGSMITH_API_KEY", "");
    expect(traceConfig({ userId: "u", workspace: "w", model: "m" })).toEqual({});
    expect(describeTracing()).toMatch(/LANGSMITH_API_KEY is empty/);
  });

  it("traces the run and its subagent, tagged with the user, with credentials masked", async () => {
    vi.stubEnv("LANGSMITH_TRACING", "true");
    const uploaded = await tracedRun();

    expect(uploaded).toContain(FILE_MARKER);
    expect(uploaded).toContain("octocat");
    expect(uploaded).toContain("https://github.com/o/r");
    expect(uploaded).toContain("helper");
    // LangSmith groups a conversation's runs into one thread by this metadata key.
    expect(uploaded).toMatch(/"thread_id":\s*"thread-7f3a"/);
    // With LANGSMITH_TRACING on, LangChain would add its own unmasked tracer if ours were not
    // recognised — so this also shows there is no second copy of the run.
    expect(uploaded).not.toContain(SECRET);
  });

  // Regression guard for the installed client preferring an anonymizer over the environment.
  it("sends no content at all when inputs and outputs are hidden", async () => {
    vi.stubEnv("LANGSMITH_TRACING", "true");
    vi.stubEnv("LANGSMITH_HIDE_INPUTS", "true");
    vi.stubEnv("LANGSMITH_HIDE_OUTPUTS", "true");
    const uploaded = await tracedRun();

    expect(uploaded).toContain("octocat");
    expect(uploaded).not.toContain(FILE_MARKER);
    expect(uploaded).not.toContain(SECRET);
  });

  it("masks credentials with LangSmith's rules and the model-side ones", async () => {
    const { maskSecrets } = await import("./tracing.js");
    const masked = maskSecrets({
      messages: [{ content: [{ type: "text", text: `key ${SECRET} and postgres://admin:hunter22@db:5432/app` }] }],
    });
    const text = JSON.stringify(masked);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("hunter22");
    expect(text).toContain("db:5432/app");
  });
});
