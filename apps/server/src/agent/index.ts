import {
  createDeepAgent,
  createSummarizationMiddleware,
  CompositeBackend,
  FilesystemBackend,
  LocalShellBackend,
  StateBackend,
  type DeepAgent,
} from "deepagents";
import { todoListMiddleware, modelRetryMiddleware, toolRetryMiddleware, toolCallLimitMiddleware, modelFallbackMiddleware } from "langchain";
import type { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { ModelId, WorkspaceOptions } from "@deepagents-ide/shared";
import { providerOf, resolveModel } from "./models.js";
import { migrationSubagents, SUBAGENT_INFO } from "./subagents.js";
import { writeInterrupt } from "./permissions.js";
import { connectGithubTools } from "./github.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { migrationLedgerMiddleware } from "./ledger.js";
import { scopeGuardrailMiddleware } from "./guardrails.js";
import { secretRedactionMiddleware } from "./secretRedaction.js";
import type { E2BSandbox } from "./e2bSandbox.js";
import { SKILLS_DIR, SKILLS_MOUNT, MEMORIES_MOUNT } from "./paths.js";
import { getPersistence } from "./persistence.js";

export { SYSTEM_PROMPT, SUBAGENT_INFO };

/**
 * If the opened project has its own `.deepagents/AGENTS.md`, deepagents loads it
 * and merges it into the system prompt (same idea as Claude Code's CLAUDE.md) —
 * this is deepagents' own `memory` feature, resolved through the same backend as
 * the rest of the agent, so it's read relative to the opened workspace, not this repo.
 */
const PROJECT_MEMORY_SOURCES = ["./.deepagents/AGENTS.md"];

export interface WorkspaceAgent {
  agent: DeepAgent;
  threadId: string;
  mcpClient?: MultiServerMCPClient;
  githubToolCount: number;
}

/**
 * Which model keys a workspace may use. Under GitHub login `allowServerKeys` is false and
 * `providerKeys` holds the user's own keys, one per provider id.
 */
export interface ModelCredentials {
  allowServerKeys: boolean;
  providerKeys: Record<string, string | undefined>;
}

export async function createWorkspaceAgent(
  projectRoot: string,
  model: ModelId,
  threadId: string,
  options: WorkspaceOptions = {},
  sandbox?: E2BSandbox,
  credentials: ModelCredentials = { allowServerKeys: true, providerKeys: {} }
): Promise<WorkspaceAgent> {
  // With a sandbox, every file operation and shell command the agent makes happens in a
  // disposable microVM instead of on this host. deepagents' own documentation says
  // LocalShellBackend — the alternative below — is for "dedicated development environments"
  // and never production systems, since `execute` runs with the server process's privileges.
  const projectBackend =
    sandbox ??
    new LocalShellBackend({
      rootDir: projectRoot,
      timeout: 120,
      virtualMode: true,
      // Without this the backend spawns every shell command with a completely empty
      // environment — no PATH — so python, pip, pytest, npm, node and git all fail to
      // resolve, which silently breaks any "migrate, then actually run the tests" flow.
      inheritEnv: true,
    });

  // The project stays the default route so `execute` keeps working — CompositeBackend
  // always delegates shell execution to the default backend specifically, never to a
  // routed one (verified against the framework source), so the project cannot be moved
  // behind a prefix without breaking every shell command.
  //
  // deepagents itself writes two kinds of internal bookkeeping through whatever backend
  // it was given: evicted large tool results (`/large_tool_results/<id>.txt`) and
  // offloaded conversation history (`/conversation_history/<id>`) once summarization
  // kicks in. Left unmapped, those fall through to the default — meaning they would land
  // as real files inside the user's own git repository. Routing them to a StateBackend
  // keeps them thread-scoped and checkpointed instead, exactly like every other backend
  // deepagents ships that doesn't have a real project attached.
  //
  // StateBackend needs the live LangGraph runtime to read/write state, which only exists
  // once a run is actually in progress — so the whole backend is built as a factory
  // (deepagents' own default backend uses this exact same pattern) and resolved fresh by
  // whichever middleware needs it, rather than constructed once up front.
  const persistence = await getPersistence();

  const backend = (runtime: unknown) =>
    new CompositeBackend(projectBackend, {
      [SKILLS_MOUNT]: new FilesystemBackend({ rootDir: SKILLS_DIR, virtualMode: true }),
      [MEMORIES_MOUNT]: persistence.memories,
      // Cast: the exact BackendRuntime shape is deepagents' own internal type — this
      // factory only ever receives whatever it hands us, so trusting that value at the
      // boundary is enough without re-declaring its shape here.
      "/large_tool_results/": new StateBackend(runtime as never),
      "/conversation_history/": new StateBackend(runtime as never),
    });

  const autoApprovePaths = options.autoApprovePaths ?? [];
  const protectedPaths = options.readOnlyPaths ?? [];
  // Fallback ids given as plain strings are resolved by LangChain from the server's environment,
  // so without server keys each one is built with the user's own key instead — and a fallback
  // for a provider the user has no key for is dropped rather than silently billed to the server.
  const fallbacks = (options.fallbackModels ?? []).flatMap((fallback) => {
    if (credentials.allowServerKeys) return [fallback];
    try {
      return [resolveModel(fallback, credentials.providerKeys[providerOf(fallback)], false)];
    } catch {
      return [];
    }
  });
  const { tools: githubTools, client: mcpClient } = await connectGithubTools(options.githubToken);

  const agent = createDeepAgent({
    model: resolveModel(model, options.apiKey ?? credentials.providerKeys[providerOf(model)], credentials.allowServerKeys),
    backend,
    tools: githubTools,
    systemPrompt: SYSTEM_PROMPT,
    middleware: [
      // deepagents places custom middleware after its own built-ins, so this is not literally
      // first — but it is a beforeAgent hook, and every one of those runs before the first
      // model call, so an off-topic request is still declined at no cost.
      scopeGuardrailMiddleware(),
      todoListMiddleware(),
      migrationLedgerMiddleware(),
      // Keeps live credentials read out of the project from reaching the model provider.
      // See secretRedaction.ts for why the built-in PII types are unsuitable here.
      secretRedactionMiddleware(),
      // A migration is a long single conversation over many files, so it hits the context
      // limit sooner than a normal chat. Summarize on a fraction of the model's own window
      // rather than a fixed token count (model-agnostic), keep enough recent turns that the
      // current file's context survives the cut, and shrink the bulky tool arguments in
      // older turns — those are mostly whole file bodies already written to disk.
      createSummarizationMiddleware({
        backend,
        trigger: { type: "fraction", value: 0.7 },
        keep: { type: "messages", value: 30 },
        truncateArgsSettings: { trigger: { type: "fraction", value: 0.5 } },
      }),
      // Defaults (2 retries, 1s/2s backoff) only wait ~3s total before giving up — far
      // shorter than the ~30-60s window free-tier providers (Gemini in particular) ask
      // for in their 429 responses. This backoff (~5s/10s/20s ≈ 35s total) gives a
      // per-minute quota window time to actually roll over instead of failing the turn
      // immediately on a transient rate limit.
      modelRetryMiddleware({ maxRetries: 3, initialDelayMs: 5000, maxDelayMs: 40000 }),
      toolRetryMiddleware(),
      // A migration run loops over many files; this stops a stuck agent from
      // burning the whole budget on a retry loop rather than failing loudly.
      toolCallLimitMiddleware({ runLimit: 150, exitBehavior: "end" }),
      ...(fallbacks.length > 0 ? [modelFallbackMiddleware(...(fallbacks as Parameters<typeof modelFallbackMiddleware>))] : []),
    ],
    // Includes our own `general-purpose` subagent, which replaces the framework's built-in
    // one — see its spec in subagents.ts.
    subagents: migrationSubagents(backend, protectedPaths),
    skills: [SKILLS_MOUNT],
    memory: PROJECT_MEMORY_SOURCES,
    checkpointer: persistence.checkpointer,
    interruptOn: {
      write_file: writeInterrupt(autoApprovePaths, protectedPaths),
      edit_file: writeInterrupt(autoApprovePaths, protectedPaths),
      delete: writeInterrupt(autoApprovePaths, protectedPaths),
      execute: true,
    },
  });

  return { agent, threadId, mcpClient, githubToolCount: githubTools.length };
}

/**
 * `user_id` scopes /memories/ to the signed-in user (see persistence.ts). Left out when there are
 * no separate accounts, so everything keeps using the one shared namespace it always had.
 */
export function runConfig(threadId: string, userId?: string) {
  return { configurable: userId ? { thread_id: threadId, user_id: userId } : { thread_id: threadId } };
}

/** Wipes a project's checkpointed conversation so the next message starts genuinely fresh. */
export async function clearThread(threadId: string): Promise<void> {
  const { checkpointer } = await getPersistence();
  await checkpointer.deleteThread(threadId);
}
