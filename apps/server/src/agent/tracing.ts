import { Client } from "langsmith";
import { createAnonymizer, createSecretAnonymizer } from "langsmith/anonymizer";
import { LangChainTracer } from "@langchain/core/tracers/tracer_langchain";
import { redactText } from "./secretRedaction.js";

/**
 * LangSmith tracing for agent runs — every model call, tool call and subagent, so a failed or
 * expensive migration can be looked at afterwards instead of guessed at.
 *
 * Off unless the operator sets LANGSMITH_TRACING=true and LANGSMITH_API_KEY. The client reads
 * the rest of the standard LANGSMITH_* variables itself (project, endpoint — the EU one included
 * — and sampling rate).
 *
 * What leaves the server: traces carry the project's source code, because that is what the agent
 * reads and writes. Credentials are masked first, with LangSmith's own secret rules plus the
 * patterns the model-side redaction uses. Masking matters more here than it does for the model:
 * a trace records each tool's raw result — a `read_file` of a committed `.env` — before
 * secretRedactionMiddleware has run. LANGSMITH_HIDE_INPUTS / LANGSMITH_HIDE_OUTPUTS drop content
 * entirely and keep only the shape, timing, token counts and errors.
 */

const DEFAULT_PROJECT = "code-migration-agents";

function flag(name: string): boolean {
  return ["true", "1"].includes((process.env[name] ?? "").trim().toLowerCase());
}

export function isTracingEnabled(): boolean {
  return (flag("LANGSMITH_TRACING") || flag("LANGSMITH_TRACING_V2")) && !!process.env.LANGSMITH_API_KEY?.trim();
}

export type TraceContent = "hidden" | "masked";

export function traceContent(): { inputs: TraceContent; outputs: TraceContent } {
  return {
    inputs: flag("LANGSMITH_HIDE_INPUTS") ? "hidden" : "masked",
    outputs: flag("LANGSMITH_HIDE_OUTPUTS") ? "hidden" : "masked",
  };
}

/** Both passes over every string in a run: LangSmith's secret rules, then ours. */
export function maskSecrets<T>(data: T): T {
  return ours(builtIn(data));
}
const builtIn = createSecretAnonymizer();
// Same depth as createSecretAnonymizer: traced payloads nest deeply
// (messages[].content[].args), and createAnonymizer's default of 10 stops short of that.
const ours = createAnonymizer((value) => redactText(value), { maxDepth: 24 });

let client: Client | undefined;

function tracingClient(): Client {
  if (!client) {
    const content = traceContent();
    client = new Client({
      anonymizer: maskSecrets,
      // Passed explicitly rather than left to the environment: the installed client resolves
      // `config.hideInputs ?? config.anonymizer ?? env`, so with an anonymizer configured,
      // LANGSMITH_HIDE_INPUTS=true would otherwise be ignored and masked content sent anyway —
      // the opposite of what the docs say and of what the operator asked for.
      hideInputs: content.inputs === "hidden" ? true : maskSecrets,
      hideOutputs: content.outputs === "hidden" ? true : maskSecrets,
    });
  }
  return client;
}

export interface TraceTags {
  /** Stable user id, e.g. "gh:12345". */
  userId: string;
  /** GitHub login, for finding a user's runs by name. */
  userLogin?: string;
  /** What was opened: a repository URL or a local path. */
  workspace: string;
  model: string;
}

/**
 * Run-config additions for one agent run: its tracer, and metadata to filter by in LangSmith.
 * Empty when tracing is off, so it can be spread into every run's config unconditionally.
 *
 * A tracer passed here also stops LangChain adding its own environment-configured one (it only
 * does so when none is present), so there is never a second, unmasked copy of a run. Subagents
 * receive it through the config deepagents hands them, and so are traced as children of the run.
 */
export function traceConfig(tags: TraceTags): { callbacks?: LangChainTracer[]; metadata?: Record<string, string>; tags?: string[] } {
  if (!isTracingEnabled()) return {};
  return {
    callbacks: [new LangChainTracer({ client: tracingClient(), projectName: process.env.LANGSMITH_PROJECT?.trim() || DEFAULT_PROJECT })],
    metadata: {
      user_id: tags.userId,
      ...(tags.userLogin ? { user_login: tags.userLogin } : {}),
      workspace: tags.workspace,
      model: tags.model,
    },
    tags: ["code-migration", `model:${tags.model.split(":")[0]}`],
  };
}

/** Sends traces still queued. Called on shutdown, so a deploy does not drop the last runs. */
export async function flushTraces(): Promise<void> {
  await client?.awaitPendingTraceBatches();
}

/** One line at startup, so it is obvious from the logs whether runs are leaving the server. */
export function describeTracing(): string {
  if (!isTracingEnabled()) {
    return flag("LANGSMITH_TRACING") ? "LangSmith tracing: off — LANGSMITH_TRACING is set but LANGSMITH_API_KEY is empty" : "LangSmith tracing: off";
  }
  const content = traceContent();
  const project = process.env.LANGSMITH_PROJECT?.trim() || DEFAULT_PROJECT;
  return `LangSmith tracing: on — project "${project}", inputs ${content.inputs}, outputs ${content.outputs}`;
}
