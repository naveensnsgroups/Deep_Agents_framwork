import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { Command, REMOVE_ALL_MESSAGES } from "@langchain/langgraph";
import { RemoveMessage } from "@langchain/core/messages";
import { createWorkspaceAgent, runConfig, clearThread, type ModelCredentials, type WorkspaceAgent } from "./agent/index.js";
import {
  isGitUrl,
  resolveGitWorkspace,
  pushWorkspace,
  cloneIntoSandbox,
  pushFromSandbox,
  assertNoEmbeddedCredentials,
  assertGitHubRepo,
} from "./agent/gitWorkspace.js";
import { selectSubprotocol, userForUpgrade, userScope } from "./auth.js";
import { keepAlive } from "./heartbeat.js";
import { allowWorkspaceRoot, assertHostWorkspacesAllowed } from "./workspaceRegistry.js";
import type { E2BSandbox } from "./agent/e2bSandbox.js";
import { acquireSandbox, isE2BEnabled, releaseSandbox } from "./agent/sandboxSession.js";
import { GITHUB_OAUTH_SECRET, getUserSecret, USER_KEYS } from "./userSecrets.js";
import { isReadTool, readTargetOf, scanForAgentDirectedText } from "./agent/injectionSignals.js";
import { AnswerCollector, pendingInterrupts } from "./agent/pendingInterrupts.js";
import { SubagentTracker } from "./agent/subagentTracker.js";
import { traceConfig, type TraceTags } from "./agent/tracing.js";
import type {
  ClientToServerMessage,
  ServerToClientMessage,
  Todo,
  LedgerEntry,
  ReadProvenance,
  SessionUser,
  WorkspaceOptions,
} from "@deepagents-ide/shared";

interface Session {
  /** Who this connection belongs to — fixed at the handshake. */
  user: SessionUser;
  /** The id data is scoped to, or undefined when there are no separate accounts. See userScope. */
  scope?: string;
  workspaceAgent?: WorkspaceAgent;
  lastMessageCount: number;
  toolCallArgs: Map<string, Record<string, unknown>>;
  /** Set only while a turn is actively streaming, so a "stop" message has something to abort. */
  abortController?: AbortController;
  /** Set only when the current workspace was cloned from a GitHub URL (vs. a local path
   * the backend already had access to) — gates whether "push_changes" has anything to do. */
  gitWorkspaceDir?: string;
  /** Remembered from set_workspace's options so a later push_changes doesn't need it
   * resupplied — server-memory only, same as every other credential in this app. */
  githubToken?: string;
  /** Set only in sandbox mode: the microVM this session's agent, files and terminal share. */
  sandbox?: E2BSandbox;
  /** The `e2b://<id>` handle standing in for a project path while a sandbox is open. */
  sandboxRoot?: string;
  /**
   * The most recent file reads, newest last, capped at RECENT_READ_LIMIT. Attached to an
   * approval card so the reviewer can see what the agent had just read when it proposed the
   * action — the difference between a command the agent reasoned out and one a file asked
   * for. Reset each turn: provenance from a previous turn would be misleading rather than
   * merely stale.
   */
  recentReads: ReadProvenance[];
  /** What the run is paused on, and the answers given so far. See AnswerCollector. */
  answers: AnswerCollector;
  /** Who and what this workspace's runs are, for finding them in LangSmith. */
  traceTags?: TraceTags;
}

/**
 * Tells the client about every request the thread is paused on. Read from the checkpoint after a
 * run rather than from the stream's interrupt events, so a live run and a reconnect report the
 * same thing — every pending request, each with the id it is answered by.
 */
function announcePending(ws: WebSocket, session: Session, snapshot: Parameters<typeof pendingInterrupts>[0], provenance: ReadProvenance[]) {
  const pending = pendingInterrupts(snapshot);
  session.answers.reset(pending);
  for (const p of pending) {
    if (p.kind === "question") {
      send(ws, { type: "question_request", interruptId: p.id, question: p.question, options: p.options });
    } else {
      send(ws, { type: "interrupt_request", interruptId: p.id, actionRequests: p.actionRequests, reviewConfigs: p.reviewConfigs, provenance });
    }
  }
}

/**
 * Enough to cover the reads that plausibly motivated one action, without turning the card
 * into a log. A converter typically reads the rulebook, a playbook and the source file
 * before writing anything.
 */
const RECENT_READ_LIMIT = 6;

/**
 * Records a read for provenance. Applies to subagent reads too (not just the top-level
 * agent's): a subagent's interrupt surfaces to the same human, and the file that influenced
 * it is just as relevant there.
 */
function noteRead(session: Session, name: string, args: Record<string, unknown>, result: string) {
  if (!isReadTool(name)) return;
  session.recentReads.push({ target: readTargetOf(args), tool: name, signals: scanForAgentDirectedText(result) });
  if (session.recentReads.length > RECENT_READ_LIMIT) session.recentReads.shift();
}

function send(ws: WebSocket, msg: ServerToClientMessage) {
  ws.send(JSON.stringify(msg));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One persistent LangGraph thread per project folder, not a random ID per connection —
 * reopening the same folder resumes the same conversation instead of starting a new one
 * every time the page reloads. Slash direction and trailing slashes are normalized so the
 * same folder typed two ways lands on one thread.
 *
 * Case is folded only on Windows, where the filesystem is genuinely case-insensitive and
 * `C:\Proj` and `c:\proj` are the same directory. Folding it everywhere meant that on Linux
 * — i.e. any cloud deployment — `/srv/ProjA` and `/srv/proja` collapsed into a single
 * thread despite being two different projects, so one would open with the other's history
 * and migration ledger.
 */
function projectKeyFor(projectRoot: string): string {
  const normalized = projectRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Under GitHub login the thread is also keyed by the user, so two people opening the same repo
 * each get their own conversation and migration ledger instead of reading each other's.
 */
function threadIdForProject(projectRoot: string, scope?: string): string {
  const key = projectKeyFor(projectRoot);
  return scope ? `user:${scope}:${key}` : key;
}

/**
 * The keys a workspace runs on. Under GitHub login these come only from what the user supplied —
 * typed for this session, or saved in "My keys" — and never from the server's environment.
 * GitHub access for clone and push prefers a personal access token and otherwise uses the token
 * GitHub login granted; the GitHub MCP tools only ever get a token the user supplied themselves,
 * since they act on far more than the one repository being opened.
 */
async function resolveCredentials(
  session: Session,
  options: WorkspaceOptions
): Promise<{ credentials: ModelCredentials; gitToken?: string; mcpToken?: string }> {
  if (!session.scope) {
    return { credentials: { allowServerKeys: true, providerKeys: {} }, gitToken: options.githubToken, mcpToken: options.githubToken };
  }

  const userId = session.user.id;
  const providerKeys: Record<string, string | undefined> = {};
  for (const { name } of USER_KEYS) {
    if (name !== "github") providerKeys[name] = await getUserSecret(userId, name);
  }
  const personalToken = options.githubToken || (await getUserSecret(userId, "github"));
  return {
    credentials: { allowServerKeys: false, providerKeys },
    gitToken: personalToken || (await getUserSecret(userId, GITHUB_OAUTH_SECRET)),
    mcpToken: personalToken,
  };
}

interface LcMessage {
  getType?: () => string;
  _getType?: () => string;
  content: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; name: string; args: Record<string, unknown> }>;
  status?: "success" | "error";
}

function messageType(m: LcMessage): string {
  return m.getType ? m.getType() : m._getType ? m._getType() : "unknown";
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : typeof c === "object" && c && "text" in c ? String((c as { text: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
}

/**
 * Used only for history replay (drip-feeding old text back has no reason to be slow) and
 * as the reveal for `agent.streamEvents`-based real streaming, which turned out to be
 * unusable: it drops the tool-result message from the follow-up request specifically for
 * Gemini — a bug in `@langchain/google-genai`'s conversion path for that particular API.
 * Real live streaming now goes through `runStreaming` below instead, built on
 * `agent.stream({streamMode: [...], subgraphs: true})` — LangGraph's own lower-level
 * primitive, verified (via a real request against the exact interrupt/resume cycle that
 * broke streamEvents) to not share that bug, on every provider including Gemini.
 */
async function streamTextToClient(ws: WebSocket, text: string, instant: boolean) {
  const id = randomUUID();
  send(ws, { type: "agent_message_start", id });
  if (instant) {
    send(ws, { type: "agent_message_delta", id, delta: text });
  } else {
    const CHUNK_SIZE = 3;
    for (let i = 0; i < text.length; i += CHUNK_SIZE) {
      send(ws, { type: "agent_message_delta", id, delta: text.slice(i, i + CHUNK_SIZE) });
      await sleep(12);
    }
  }
  send(ws, { type: "agent_message_end", id });
}

async function extractNewEvents(ws: WebSocket, session: Session, messages: LcMessage[], instant = false) {
  const newMessages = messages.slice(session.lastMessageCount);
  session.lastMessageCount = messages.length;

  for (const m of newMessages) {
    const type = messageType(m);

    if (type === "human") {
      // Only relevant during history replay — live user messages are already added
      // client-side the moment they're sent, so echoing them back would duplicate them.
      if (instant) {
        const text = messageText(m.content);
        if (text.trim()) send(ws, { type: "user_message_replay", content: text });
      }
      continue;
    }

    if (type === "ai" && Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) {
        if (call.id) session.toolCallArgs.set(call.id, call.args ?? {});
      }
    }
    if (type === "tool") {
      const toolCallId = m.tool_call_id ?? "";
      // Sent immediately rather than batched at the end of the loop: batching was invisible
      // for a single live turn (usually one tool call before the closing text) but put every
      // tool call from a replayed multi-turn history after all the replayed text instead of
      // in its real chronological position.
      send(ws, {
        type: "tool_call_result",
        results: [
          {
            toolCallId,
            name: m.name ?? "tool",
            args: session.toolCallArgs.get(toolCallId) ?? {},
            result: messageText(m.content) || JSON.stringify(m.content),
            status: m.status,
          },
        ],
      });
    } else if (type === "ai") {
      const text = messageText(m.content);
      if (text.trim()) {
        // modelRetryMiddleware's onFailure:"continue" (our default) injects a plain AIMessage
        // starting with this exact literal once retries are exhausted (verified against the
        // installed package source). Route it to the error UI instead of the chat stream —
        // otherwise raw provider error JSON flows through Markdown and gets auto-linkified.
        if (text.startsWith("Model call failed after ")) {
          send(ws, { type: "error", message: text });
        } else {
          await streamTextToClient(ws, text, instant);
        }
      }
    }
  }
}

/**
 * A `[namespace, mode, payload]` tuple from `agent.stream({streamMode: [...], subgraphs:
 * true})`. `namespace` locates the event in the graph: `[]` is the top-level agent, one
 * entry per nesting level below that (e.g. `["tools:<call-id>"]` is inside a tool's own
 * subgraph — which is where a delegated subagent's entire run lives).
 */
type StreamTuple = [string[], "updates" | "messages" | "tasks", unknown];

interface StreamChunk {
  id?: string;
  content: unknown;
}

interface StreamAiMessage {
  id?: string;
  content: unknown;
  tool_calls?: Array<{ id?: string; name: string; args: Record<string, unknown> }>;
}

interface StreamToolMessage {
  content: unknown;
  tool_call_id?: string;
  name?: string;
  status?: "success" | "error";
}

/**
 * Drives a single turn with real, live token streaming instead of `.invoke()` + a
 * simulated reveal. Runs identically for every provider — see the note on
 * `streamTextToClient` for why `agent.stream()` rather than `agent.streamEvents()`.
 *
 * Event shapes here were captured directly from real requests (including through an
 * actual interrupt → resume cycle), not assumed from documentation:
 *   - `"messages"` mode yields incremental `AIMessageChunk`s for the top-level agent's own
 *     model turns only. A pure tool-call turn streams no text at all (Gemini does not
 *     stream partial tool-call JSON the way OpenAI does), so a message bubble is only
 *     opened once real text actually arrives — never an empty one.
 *   - `"updates"` mode delivers each node's *finished* output once. A `tools` entry
 *     carries the completed `ToolMessage`(s) and, as sibling keys on the same payload, any
 *     state a tool's Command update touched — `todos` for `write_todos`, `migrationLedger`
 *     for `record_migration`. A `model_request` entry carries the finished `AIMessage`,
 *     which is where tool-call args get recorded and where a streamed bubble is closed.
 *   - `namespace.length === 0` means the update reached the root graph's own state — a
 *     subagent's internal tool calls and todo/ledger writes stay scoped to its own
 *     subgraph and are filtered out here, exactly as they always were invisible to the
 *     main timeline under `.invoke()`.
 */
async function runStreaming(
  ws: WebSocket,
  session: Session,
  agent: WorkspaceAgent["agent"],
  input: unknown,
  config: ReturnType<typeof runConfig>
) {
  // Verified against LangGraph's own source (runner.js): a signal passed in here is combined
  // with the graph's internal per-step signals and races the pending task, so it genuinely
  // stops model generation (the fetch itself is aborted) and prevents any further step from
  // starting. It does NOT reach deepagents' LocalShellBackend.execute(), which spawns its
  // child process without ever wiring a signal in — so a shell command already running when
  // "stop" arrives keeps running to completion in the background; only the graph stops
  // waiting on it. That gap is called out in the message we send back on abort.
  const controller = new AbortController();
  session.abortController = controller;

  // Provenance is per-turn. Carrying last turn's reads onto this turn's approval card would
  // point at files that had nothing to do with the action being approved.
  session.recentReads = [];

  // One entry per in-flight AI text bubble, keyed by the LangChain message id so repeated
  // chunks for the same turn accumulate into one bubble rather than starting a new one.
  const openBubbles = new Set<string>();
  const subagents = new SubagentTracker();

  try {
    const stream = (await agent.stream(input, {
      // "tasks" is only for the subagent cards: it is what ties a subagent's events to the
      // `task` call that launched it. See SubagentTracker.
      streamMode: ["updates", "messages", "tasks"],
      subgraphs: true,
      ...config,
      ...(session.traceTags ? traceConfig(session.traceTags) : {}),
      signal: controller.signal,
    } as never)) as AsyncIterable<StreamTuple>;

    for await (const [namespace, mode, payload] of stream) {
      if (mode === "tasks") {
        for (const event of subagents.onTask(namespace, payload as Parameters<SubagentTracker["onTask"]>[1])) send(ws, event);
        continue;
      }

      if (mode === "messages") {
      // Only the top-level agent's own model turns. A delegated subagent's model calls
      // are nested one level deeper (under its own "tools:<call-id>" entry) and stay
      // invisible here — same as they always were, since `.invoke()`'s top-level
      // `messages` array never contained subagent-internal turns either.
      if (namespace.length !== 1 || !namespace[0].startsWith("model_request:")) continue;

      const [chunk] = payload as [StreamChunk, unknown];
      if (!chunk.id) continue;
      const text = messageText(chunk.content);
      if (!text) continue;

      if (!openBubbles.has(chunk.id)) {
        send(ws, { type: "agent_message_start", id: chunk.id });
        openBubbles.add(chunk.id);
      }
      send(ws, { type: "agent_message_delta", id: chunk.id, delta: text });
      continue;
    }

    // mode === "updates"
    const update = payload as Record<string, unknown>;

    // Announced from the checkpoint once the run stops (see the `finally` below). The stream
    // reports interrupts per graph level, and only the first one was ever shown — with parallel
    // subagents the rest went unseen, then got answered along with it.
    if ("__interrupt__" in update) continue;

    for (const event of subagents.onUpdate(namespace, update)) send(ws, event);

    // Recorded for every namespace, unlike everything below. Tool-call arguments are what
    // name the file a later read result refers to, and a subagent's reads matter for
    // provenance — its interrupt surfaces to the same person. Its tool results stay off the
    // main timeline; the subagent cards show what it is doing instead.
    if ("model_request" in update) {
      const inner = update.model_request as { messages?: StreamAiMessage[] };
      for (const m of inner.messages ?? []) {
        for (const call of m.tool_calls ?? []) {
          if (call.id) session.toolCallArgs.set(call.id, call.args ?? {});
        }
      }
    }
    if ("tools" in update) {
      const inner = update.tools as { messages?: StreamToolMessage[] };
      for (const m of inner.messages ?? []) {
        const id = m.tool_call_id ?? "";
        noteRead(session, m.name ?? "", session.toolCallArgs.get(id) ?? {}, messageText(m.content));
      }
    }

    if (namespace.length !== 0) continue; // subagent-internal — stays off the main timeline

    if ("model_request" in update) {
      const inner = update.model_request as { messages?: StreamAiMessage[] };
      for (const m of inner.messages ?? []) {
        // modelRetryMiddleware's exhausted-retries message is constructed directly by the
        // middleware, never streamed as chunks, so it can only be caught here — same
        // detection as the replay path below.
        const text = messageText(m.content);
        if (text.startsWith("Model call failed after ")) {
          send(ws, { type: "error", message: text });
        } else if (m.id && openBubbles.has(m.id)) {
          send(ws, { type: "agent_message_end", id: m.id });
          openBubbles.delete(m.id);
        }
      }
    }

    if ("tools" in update) {
      const inner = update.tools as { messages?: StreamToolMessage[]; todos?: Todo[]; migrationLedger?: LedgerEntry[] };
      for (const m of inner.messages ?? []) {
        const toolCallId = m.tool_call_id ?? "";
        send(ws, {
          type: "tool_call_result",
          results: [
            {
              toolCallId,
              name: m.name ?? "tool",
              args: session.toolCallArgs.get(toolCallId) ?? {},
              result: messageText(m.content) || JSON.stringify(m.content),
              status: m.status,
            },
          ],
        });
      }
      if (Array.isArray(inner.todos)) send(ws, { type: "todo_update", todos: inner.todos });
      if (Array.isArray(inner.migrationLedger)) send(ws, { type: "ledger_update", entries: inner.migrationLedger });
    }
    }
  } catch (err) {
    if (!controller.signal.aborted) throw err;
    send(ws, {
      type: "error",
      message: "Stopped. If a shell command was already running, it may still be finishing in the background — there's no way to force-kill it mid-flight yet.",
    });
  } finally {
    session.abortController = undefined;

    // Everything below used to sit after the try/catch, which meant a turn that failed for
    // any reason other than an abort rethrew past it and never sent `turn_end` — leaving the
    // client's `streaming` flag set, so the Stop button stayed lit and no further message
    // could be sent until the page was reloaded. It belongs in `finally`: however the turn
    // ended, the client is owed the news that it ended.
    for (const id of openBubbles) send(ws, { type: "agent_message_end", id });

    // Recomputed from the authoritative final state rather than tracked incrementally
    // through the loop above — replayHistory (used on reconnect) needs this accurate so it
    // knows where to resume from without re-sending what already streamed live. Guarded
    // because a failed turn may have left no readable checkpoint, and losing the count is
    // recoverable where failing to send `turn_end` is not.
    try {
      const snapshot = (await agent.getState(config)) as unknown as StateSnapshotLike;
      session.lastMessageCount = snapshot.values?.messages?.length ?? session.lastMessageCount;
      announcePending(ws, session, snapshot, [...session.recentReads]);
    } catch {
      // keep the previous count and let replayHistory re-derive it on the next connect
    }

    send(ws, { type: "turn_end" });
  }
}

interface StateSnapshotLike {
  values?: { messages?: LcMessage[]; todos?: Todo[]; migrationLedger?: LedgerEntry[] };
  tasks?: Array<{ interrupts?: Array<{ id?: string; value?: unknown }> }>;
}

/**
 * Rebuilds the client's visible chat from whatever this project's thread already has
 * checkpointed — called right after a workspace opens, so reopening a project you've
 * already talked to shows the real conversation instead of a blank chat (the backend
 * was persisting it all along via the SQLite checkpointer; the UI just never asked for it).
 */
async function replayHistory(ws: WebSocket, session: Session, threadId: string, agent: WorkspaceAgent["agent"]) {
  let snapshot: StateSnapshotLike;
  try {
    snapshot = (await agent.getState(runConfig(threadId, session.scope))) as unknown as StateSnapshotLike;
  } catch {
    return; // no checkpoint yet for this project — nothing to replay
  }

  const messages = snapshot.values?.messages ?? [];
  if (messages.length > 0) {
    await extractNewEvents(ws, session, messages, true);
  }

  if (Array.isArray(snapshot.values?.todos) && snapshot.values.todos.length > 0) {
    send(ws, { type: "todo_update", todos: snapshot.values.todos });
  }

  if (Array.isArray(snapshot.values?.migrationLedger) && snapshot.values.migrationLedger.length > 0) {
    send(ws, { type: "ledger_update", entries: snapshot.values.migrationLedger });
  }

  // No provenance: the reads that led up to these requests happened in an earlier connection.
  announcePending(ws, session, snapshot, []);
}

/**
 * `noServer: true` — a `WebSocketServer` constructed with `{ server, path }` instead
 * registers its own `upgrade` listener on the shared http.Server and responds with an
 * active 400 (not a silent skip) whenever the path doesn't match. With two such servers
 * on one http.Server (this one and terminal.ts's), every `/ws` handshake was immediately
 * followed by the `/pty` instance's spurious 400 on the same socket, corrupting the
 * connection ("Invalid frame header" on the client) — reproduced and confirmed via a raw
 * curl upgrade request before landing this fix. `noServer: true` disables that
 * auto-registration; server.ts now owns the single `upgrade` listener and routes by path.
 */
/**
 * Largest chat message accepted. Generous for pasted code or logs; the ws library default
 * (100 MB) would let any client make the server buffer that much per message.
 */
const MAX_CHAT_MESSAGE_BYTES = 2 * 1024 * 1024;

export function createChatWebSocketServer() {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: selectSubprotocol, maxPayload: MAX_CHAT_MESSAGE_BYTES });
  keepAlive(wss);

  wss.on("connection", (ws, request) => {
    const user = userForUpgrade(request);
    const session: Session = {
      user,
      scope: userScope(user),
      lastMessageCount: 0,
      toolCallArgs: new Map(),
      recentReads: [],
      answers: new AnswerCollector(),
    };

    ws.on("close", () => {
      // Nobody is left to see the turn's output or answer its approvals, so it stops rather than
      // spending the user's key unseen. Every finished step is already checkpointed, and the
      // reconnecting client replays the conversation from there.
      session.abortController?.abort();
      session.workspaceAgent?.mcpClient?.close();
      // Kept alive for a grace period rather than killed, so a reload reconnects to it; killed
      // after that rather than billing until E2B's own timeout. See releaseSandbox.
      if (session.sandboxRoot) releaseSandbox(session.sandboxRoot);
    });

    ws.on("message", async (raw) => {
      let msg: ClientToServerMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        send(ws, { type: "error", message: "Invalid message" });
        return;
      }

      try {
        if (msg.type === "stop") {
          session.abortController?.abort();
          return;
        }

        if (msg.type === "set_workspace") {
          // Before anything derives a thread id from the input, boots a billed sandbox, or
          // tears down the workspace that is currently open.
          assertNoEmbeddedCredentials(msg.projectRoot);
          if (isGitUrl(msg.projectRoot)) assertGitHubRepo(msg.projectRoot);
          else assertHostWorkspacesAllowed();
          // A turn still running belongs to the workspace being left.
          session.abortController?.abort();
          await session.workspaceAgent?.mcpClient?.close();
          const options = msg.options ?? {};
          const { credentials, gitToken, mcpToken } = await resolveCredentials(session, options);
          session.githubToken = gitToken;

          // Identity (thread id) stays keyed by whatever the user typed — a repo URL or a
          // local path — so reopening the same one resumes the same conversation. The
          // *disk* root the backend actually operates on is a separate concern: for a git
          // URL there's no local folder to point at, so one gets created by cloning.
          const threadId = threadIdForProject(msg.projectRoot, session.scope);

          // Switching projects hands the previous sandbox back rather than killing it outright —
          // switching back within the grace period finds it still there.
          if (session.sandboxRoot) releaseSandbox(session.sandboxRoot);
          session.sandbox = undefined;
          session.sandboxRoot = undefined;
          session.workspaceAgent = undefined;

          let diskRoot = msg.projectRoot;

          if (isE2BEnabled() && isGitUrl(msg.projectRoot)) {
            // The repository is cloned straight into the microVM, so it never lands on this
            // server at all. `diskRoot` stops being a path here and becomes an `e2b://<id>`
            // handle that the file routes and terminal resolve back to this same sandbox.
            // A sandbox this user already has for this project is reused, edits and all.
            const acquired = await acquireSandbox({
              owner: user.id,
              projectKey: projectKeyFor(msg.projectRoot),
              prepare: (sandbox) => cloneIntoSandbox(sandbox, msg.projectRoot, gitToken),
            });
            session.sandbox = acquired.sandbox;
            session.sandboxRoot = acquired.root;
            session.gitWorkspaceDir = acquired.root;
            diskRoot = acquired.root;
          } else if (isGitUrl(msg.projectRoot)) {
            diskRoot = await resolveGitWorkspace(msg.projectRoot, gitToken, session.scope);
            session.gitWorkspaceDir = diskRoot;
          } else {
            session.gitWorkspaceDir = undefined;
          }

          // This is the only way a workspace becomes readable over the REST file routes or
          // openable as a terminal — both validate against the registry instead of trusting
          // whatever root a request carries. Registering the *resolved* value so those
          // comparisons match regardless of how the client spells it back.
          diskRoot = session.sandboxRoot ?? allowWorkspaceRoot(diskRoot, user.id);

          try {
            session.workspaceAgent = await createWorkspaceAgent(
              diskRoot,
              msg.model,
              threadId,
              { ...options, githubToken: mcpToken },
              session.sandbox,
              credentials
            );
          } catch (err) {
            // No agent will use this sandbox, so it shouldn't be held beyond the grace period.
            if (session.sandboxRoot) releaseSandbox(session.sandboxRoot);
            session.sandbox = undefined;
            session.sandboxRoot = undefined;
            throw err;
          }
          session.lastMessageCount = 0;
          session.toolCallArgs.clear();
          // The input as typed (a repository URL or a path), not the clone directory or sandbox
          // handle — it is what someone looking for these runs would search by. Checked above to
          // carry no embedded credentials.
          session.traceTags = { userId: user.id, userLogin: user.login, workspace: msg.projectRoot, model: msg.model };
          send(ws, {
            type: "workspace_ready",
            projectRoot: diskRoot,
            githubTools: session.workspaceAgent.githubToolCount,
            isGitWorkspace: !!session.gitWorkspaceDir,
          });
          await replayHistory(ws, session, threadId, session.workspaceAgent.agent);
          return;
        }

        if (msg.type === "push_changes") {
          const message = "Changes from Deep Agents IDE";
          if (session.sandbox) {
            // The edits live in the microVM, so the commit and push have to happen there.
            const result = await pushFromSandbox(session.sandbox, message, session.githubToken);
            send(ws, { type: "push_result", pushed: result.pushed, detail: result.detail });
          } else if (!session.gitWorkspaceDir) {
            send(ws, { type: "push_result", pushed: false, detail: "This workspace wasn't opened from a GitHub URL — nothing to push." });
          } else {
            const result = await pushWorkspace(session.gitWorkspaceDir, message, session.githubToken);
            send(ws, { type: "push_result", pushed: result.pushed, detail: result.detail });
          }
          return;
        }

        if (!session.workspaceAgent) {
          send(ws, { type: "error", message: "Workspace not set. Send set_workspace first." });
          return;
        }

        const { agent, threadId } = session.workspaceAgent;
        const config = runConfig(threadId, session.scope);

        // Everything below reads or writes the conversation, so it waits for the thread to be free.
        if (busyThreads.has(threadId)) {
          send(ws, { type: "error", message: THREAD_BUSY });
          return;
        }
        busyThreads.add(threadId);
        try {
          await handleThreadMessage(ws, session, msg, agent, threadId, config);
        } finally {
          busyThreads.delete(threadId);
        }
      } catch (err) {
        send(ws, { type: "error", message: (err as Error).message });
      }
    });
  });

  return wss;
}

/**
 * Conversations with something in progress. Two runs on one thread — a second tab on the same
 * project, or a message sent before the last turn finished — would interleave their
 * checkpoints and corrupt the conversation. One server process serves every connection (a
 * single ECS task), so an in-memory set covers all of them.
 */
const busyThreads = new Set<string>();

const THREAD_BUSY =
  "This conversation is already busy — in this tab or another one. Wait for it to finish, or press Stop there first.";

async function handleThreadMessage(
  ws: WebSocket,
  session: Session,
  msg: ClientToServerMessage,
  agent: WorkspaceAgent["agent"],
  threadId: string,
  config: ReturnType<typeof runConfig>
): Promise<void> {
  if (msg.type === "user_message") {
    send(ws, { type: "agent_thinking" });
    await runStreaming(ws, session, agent, { messages: [{ role: "user", content: msg.content }] }, config);
  } else if (msg.type === "resume_decisions" || msg.type === "answer_question") {
    // Nothing runs until every pending request has its answer; see AnswerCollector.
    const resume = session.answers.record(msg);
    if (!resume) return;
    send(ws, { type: "agent_thinking" });
    await runStreaming(ws, session, agent, new Command({ resume }), config);
  } else if (msg.type === "clear_chat") {
    session.answers.reset();
    await clearThread(threadId);
    session.lastMessageCount = 0;
    session.toolCallArgs.clear();
    send(ws, { type: "chat_cleared" });
  } else if (msg.type === "edit_message") {
    send(ws, { type: "agent_thinking" });
    const snapshot = (await agent.getState(config)) as unknown as { values?: { messages?: LcMessage[] } };
    const messages = snapshot.values?.messages ?? [];

    // Find the Nth human message (0-indexed) — that's the one being edited — and
    // cut everything from it onward, since editing it invalidates every reply and
    // tool call that happened after it.
    let humanSeen = -1;
    let cutIndex = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messageType(messages[i]) === "human") {
        humanSeen++;
        if (humanSeen === msg.userMessageIndex) {
          cutIndex = i;
          break;
        }
      }
    }
    if (cutIndex === -1) {
      send(ws, { type: "error", message: "Could not find that message to edit." });
      return;
    }

    const kept = messages.slice(0, cutIndex);
    // A RemoveMessage with the REMOVE_ALL_MESSAGES sentinel id, found anywhere in the
    // new messages array, tells LangGraph's reducer to discard all existing checkpointed
    // messages and keep only whatever is placed after it in this same update — i.e. `kept`
    // becomes the entire new history, with everything from the edited message onward gone.
    await (agent.updateState(config, {
      messages: [new RemoveMessage({ id: REMOVE_ALL_MESSAGES }), ...kept],
    }) as unknown as Promise<void>);
    session.lastMessageCount = kept.length;
    session.toolCallArgs.clear();

    await runStreaming(ws, session, agent, { messages: [{ role: "user", content: msg.content }] }, config);
  }
}
