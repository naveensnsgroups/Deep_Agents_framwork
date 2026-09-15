import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
// Type-only, so it is erased at compile time and does not trigger the module loads that the
// dynamic imports below are deliberately deferring until after dotenv has run.
import type { EvalTranscript } from "./cases.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Loaded before the agent module is imported, so anything reading the environment at module
// scope sees the real values. (See the note in auth.ts about ESM import hoisting.)
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const { createWorkspaceAgent, runConfig, clearThread } = await import("../src/agent/index.js");
const { CASES } = await import("./cases.js");
const { Command } = await import("@langchain/langgraph");

const FIXTURE = path.resolve(__dirname, "fixtures/express-orders");

/**
 * The model under test. Evals are about the prompts and middleware, not the model, but the
 * result is only meaningful against the model you actually ship — so this defaults to the
 * same provider the app is configured with.
 */
const MODEL = process.env.EVAL_MODEL ?? process.env.GOOGLE_MODEL ?? "google-genai:gemini-3.5-flash-lite";

/** Guards against a runaway case: a stuck agent should fail the eval, not hang CI. */
const MAX_STEPS = 12;

/**
 * Drives one case to completion and records what the agent tried to do.
 *
 * Every interrupt is rejected rather than approved. That is what makes this safe to run
 * unattended — no file is written and no command is executed — and it loses nothing, because
 * what the cases actually assert is whether a dangerous action was ever *proposed*.
 */
async function runCase(prompt: string, threadId: string): Promise<EvalTranscript> {
  const { agent } = await createWorkspaceAgent(FIXTURE, MODEL, threadId, {});
  const config = runConfig(threadId);

  const toolCalls: EvalTranscript["toolCalls"] = [];
  const textParts: string[] = [];
  let declinedByGuardrail = false;
  let input: unknown = { messages: [{ role: "user", content: prompt }] };

  for (let step = 0; step < MAX_STEPS; step++) {
    let interrupted = false;
    let pendingCount = 0;

    const stream = (await agent.stream(input, {
      streamMode: ["updates"],
      subgraphs: true,
      ...config,
    } as never)) as AsyncIterable<[string[], string, unknown]>;

    for await (const [, , payload] of stream) {
      const update = payload as Record<string, unknown>;

      if ("__interrupt__" in update) {
        const interrupts = update.__interrupt__ as Array<{ value: { actionRequests: Array<{ name: string; args: Record<string, unknown> }> } }>;
        const requests = interrupts?.[0]?.value?.actionRequests ?? [];
        // Recorded before rejection: a proposed `curl | bash` is exactly what the injection
        // cases are looking for, and it never runs.
        for (const r of requests) toolCalls.push({ name: r.name, args: r.args ?? {} });
        pendingCount = requests.length;
        interrupted = true;
        break;
      }

      if ("model_request" in update) {
        const inner = update.model_request as { messages?: Array<{ content: unknown; tool_calls?: Array<{ name: string; args: Record<string, unknown> }> }> };
        for (const m of inner.messages ?? []) {
          for (const call of m.tool_calls ?? []) toolCalls.push({ name: call.name, args: call.args ?? {} });
          if (typeof m.content === "string" && m.content.trim()) textParts.push(m.content);
        }
      }
    }

    if (!interrupted) break;
    input = new Command({ resume: { decisions: Array.from({ length: pendingCount }, () => ({ type: "reject", message: "Rejected by the evaluation harness." })) } });
  }

  // Assistant text is taken from the final checkpointed state rather than only from the
  // `model_request` updates streamed above. A turn the scope guardrail ends never produces a
  // model_request at all — that is the whole point of it — so collecting text only from the
  // stream left those runs looking like the agent had said nothing, and the guardrail case
  // failed for a reason that had nothing to do with the guardrail.
  const snapshot = (await agent.getState(config)) as unknown as {
    values?: { messages?: Array<{ getType?: () => string; content: unknown }> };
  };
  const finalMessages = snapshot.values?.messages ?? [];

  for (const m of finalMessages) {
    if (m.getType?.() !== "ai") continue;
    const content = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b) => (typeof b === "object" && b && "text" in b ? String((b as { text: unknown }).text ?? "") : "")).join("") : "";
    if (content.trim()) textParts.push(content);
  }

  const text = [...new Set(textParts)].join("\n");
  // A declined turn is one the guardrail answered itself: no tools, and its exact wording.
  declinedByGuardrail = toolCalls.length === 0 && /only work on software/i.test(text);

  return { toolCalls, text, declinedByGuardrail };
}

const filter = process.argv[2];
const selected = filter ? CASES.filter((c) => c.name.includes(filter)) : CASES;

if (selected.length === 0) {
  console.error(`No cases match "${filter}". Available:\n${CASES.map((c) => `  ${c.name}`).join("\n")}`);
  process.exit(1);
}

console.log(`Running ${selected.length} case(s) against ${MODEL}\n`);

let failed = 0;
for (const testCase of selected) {
  // A fresh thread per case, wiped first: a leftover checkpoint would let one case's
  // conversation answer the next one's question.
  const threadId = `eval:${testCase.name}`;
  await clearThread(threadId).catch(() => {});

  process.stdout.write(`  ${testCase.name} … `);
  try {
    const transcript = await runCase(testCase.prompt, threadId);
    const failure = testCase.check(transcript);
    if (failure) {
      failed++;
      console.log("FAIL");
      console.log(`      ${failure}`);
      console.log(`      why this matters: ${testCase.rationale}`);
      console.log(`      tools proposed: ${transcript.toolCalls.map((c) => c.name).join(", ") || "(none)"}`);
      console.log(`      said: ${transcript.text.slice(0, 300).replace(/\s+/g, " ")}\n`);
    } else {
      console.log("pass");
    }
  } catch (err) {
    failed++;
    console.log(`ERROR — ${(err as Error).message}\n`);
  }
}

console.log(`\n${selected.length - failed}/${selected.length} passed`);
process.exit(failed > 0 ? 1 : 0);
