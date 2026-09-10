import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { Command, REMOVE_ALL_MESSAGES } from "@langchain/langgraph";
import { RemoveMessage } from "@langchain/core/messages";
import { createWorkspaceAgent, runConfig, clearThread, type WorkspaceAgent } from "./agent/index.js";
import type {
  ClientToServerMessage,
  ServerToClientMessage,
  ActionRequest,
  ReviewConfig,
  Todo,
  LedgerEntry,
} from "@deepagents-ide/shared";

interface Session {
  workspaceAgent?: WorkspaceAgent;
  lastMessageCount: number;
  toolCallArgs: Map<string, Record<string, unknown>>;
  /** Set only while a turn is actively streaming, so a "stop" message has something to abort. */
  abortController?: AbortController;
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
 * every time the page reloads. Normalized so slashes/case/trailing-slash differences
 * between sessions still land on the same thread.
 */
function threadIdForProject(projectRoot: string): string {
  return projectRoot.trim().toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
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
type StreamTuple = [string[], "updates" | "messages", unknown];

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

  // One entry per in-flight AI text bubble, keyed by the LangChain message id so repeated
  // chunks for the same turn accumulate into one bubble rather than starting a new one.
  const openBubbles = new Set<string>();

  try {
    const stream = (await agent.stream(input, {
      streamMode: ["updates", "messages"],
      subgraphs: true,
      ...config,
      signal: controller.signal,
    } as never)) as AsyncIterable<StreamTuple>;

    for await (const [namespace, mode, payload] of stream) {
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

    if ("__interrupt__" in update) {
      const interrupts = update.__interrupt__ as Array<{ value: { actionRequests: ActionRequest[]; reviewConfigs: ReviewConfig[] } }>;
      if (interrupts?.[0]) {
        const { actionRequests, reviewConfigs } = interrupts[0].value;
        send(ws, { type: "interrupt_request", actionRequests, reviewConfigs });
      }
      continue;
    }

    if (namespace.length !== 0) continue; // subagent-internal — stays off the main timeline

    if ("model_request" in update) {
      const inner = update.model_request as { messages?: StreamAiMessage[] };
      for (const m of inner.messages ?? []) {
        for (const call of m.tool_calls ?? []) {
          if (call.id) session.toolCallArgs.set(call.id, call.args ?? {});
        }
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
    for (const id of openBubbles) send(ws, { type: "agent_message_end", id });
    send(ws, {
      type: "error",
      message: "Stopped. If a shell command was already running, it may still be finishing in the background — there's no way to force-kill it mid-flight yet.",
    });
  } finally {
    session.abortController = undefined;
  }

  // Recomputed from the authoritative final state rather than tracked incrementally
  // through the loop above — replayHistory (used on reconnect) needs this accurate so it
  // knows where to resume from without re-sending what already streamed live.
  const snapshot = (await agent.getState(config)) as unknown as { values?: { messages?: unknown[] } };
  session.lastMessageCount = snapshot.values?.messages?.length ?? session.lastMessageCount;
  send(ws, { type: "turn_end" });
}

interface StateSnapshotLike {
  values?: { messages?: LcMessage[]; todos?: Todo[]; migrationLedger?: LedgerEntry[] };
  tasks?: Array<{ interrupts?: Array<{ value: unknown }> }>;
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
    snapshot = (await agent.getState(runConfig(threadId))) as unknown as StateSnapshotLike;
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

  const pending = snapshot.tasks?.find((t) => t.interrupts && t.interrupts.length > 0);
  const interruptValue = pending?.interrupts?.[0]?.value as
    | { actionRequests: ActionRequest[]; reviewConfigs: ReviewConfig[] }
    | undefined;
  if (interruptValue) {
    send(ws, { type: "interrupt_request", actionRequests: interruptValue.actionRequests, reviewConfigs: interruptValue.reviewConfigs });
  }
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
export function createChatWebSocketServer() {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    const session: Session = { lastMessageCount: 0, toolCallArgs: new Map() };

    ws.on("close", () => {
      session.workspaceAgent?.mcpClient?.close();
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
          await session.workspaceAgent?.mcpClient?.close();
          const threadId = threadIdForProject(msg.projectRoot);
          session.workspaceAgent = await createWorkspaceAgent(msg.projectRoot, msg.model, threadId, msg.options);
          session.lastMessageCount = 0;
          session.toolCallArgs.clear();
          send(ws, { type: "workspace_ready", projectRoot: msg.projectRoot, githubTools: session.workspaceAgent.githubToolCount });
          await replayHistory(ws, session, threadId, session.workspaceAgent.agent);
          return;
        }

        if (!session.workspaceAgent) {
          send(ws, { type: "error", message: "Workspace not set. Send set_workspace first." });
          return;
        }

        const { agent, threadId } = session.workspaceAgent;
        const config = runConfig(threadId);

        if (msg.type === "user_message") {
          send(ws, { type: "agent_thinking" });
          await runStreaming(ws, session, agent, { messages: [{ role: "user", content: msg.content }] }, config);
        } else if (msg.type === "resume_decisions") {
          send(ws, { type: "agent_thinking" });
          await runStreaming(ws, session, agent, new Command({ resume: { decisions: msg.decisions } }), config);
        } else if (msg.type === "clear_chat") {
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
      } catch (err) {
        send(ws, { type: "error", message: (err as Error).message });
      }
    });
  });

  return wss;
}
