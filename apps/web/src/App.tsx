import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { SquareTerminal } from "lucide-react";
import type { FileNode, LedgerEntry, ModelId, Todo, WorkspaceOptions } from "@deepagents-ide/shared";
import { WorkspacePicker } from "./components/workspace/WorkspacePicker";
import { FileTree } from "./components/editor/FileTree";
import { ChatPanel } from "./components/chat/ChatPanel";
import { TodoPanel } from "./components/chat/TodoPanel";
import { LedgerPanel } from "./components/chat/LedgerPanel";
import { ChangesPanel } from "./components/chat/ChangesPanel";
import { ChatHeader } from "./components/chat/ChatHeader";
import { Header } from "./components/layout/Header";
import { SettingsPanel } from "./components/layout/SettingsPanel";
import { ResizablePanels } from "./components/layout/ResizablePanels";
import { AgentSocket, SERVER_URL, type ConnectionState } from "./lib/ws-client";
import { apiFetch } from "./lib/auth";
import { randomId } from "./lib/browser";
import type { Decision, TimelineItem } from "./types";

const uid = randomId;

/** Enough to see what a subagent has been doing lately; a long run's full history is not the point. */
const SUBAGENT_ACTIVITY_LIMIT = 30;

/** A turn has ended, so no subagent in it can still be running. */
function stopRunningSubagents(t: TimelineItem[]): TimelineItem[] {
  return t.some((item) => item.kind === "subagent" && item.status === "running")
    ? t.map((item) => (item.kind === "subagent" && item.status === "running" ? { ...item, status: "stopped" } : item))
    : t;
}

// Monaco and xterm are most of the bundle, and neither is needed to log in or pick a
// workspace — loading them up front made the first screen wait for code it never used.
const Editor = lazy(() => import("./components/editor/Editor").then((m) => ({ default: m.Editor })));
const TerminalPanel = lazy(() => import("./components/terminal/TerminalPanel").then((m) => ({ default: m.TerminalPanel })));

export default function App() {
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [busy, setBusy] = useState(false);
  // True from the moment a turn is sent until the server confirms it's fully done
  // (turn_end) — separate from `busy`, which only covers the pre-first-token gap.
  // Governs whether the Stop button is shown.
  const [streaming, setStreaming] = useState(false);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  // Bumped whenever the working tree may have changed, so the Changes panel fetches again.
  const [changesVersion, setChangesVersion] = useState(0);
  const [model, setModel] = useState<ModelId>("");
  const [showSettings, setShowSettings] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [autoApproveNames, setAutoApproveNames] = useState<string[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const socketRef = useRef<AgentSocket | null>(null);
  // The root the server resolved (a clone directory or `e2b://<id>`), which is what the file
  // routes accept — not the URL typed into the picker. Read from socket handlers, whose
  // closures would otherwise keep the typed value forever.
  const resolvedRootRef = useRef<string | null>(null);
  const selectedPathRef = useRef<string | null>(null);
  const autoApproveRef = useRef<Set<string>>(new Set());
  // Counts human messages in arrival order so an edit can identify — and the backend can
  // truncate from — the exact turn being edited, the same way it counts "human" messages
  // in the checkpointed LangGraph state.
  const userMessageCountRef = useRef(0);
  // Requests still waiting for the user. The server resumes the run only once all of them are
  // answered, so the turn counts as running again only when this empties.
  const waitingRef = useRef<Set<string>>(new Set());

  // The socket reconnects on its own, so it must be told when the app goes away (signing out,
  // an expired session) — otherwise it would keep reconnecting in the background forever.
  useEffect(() => () => socketRef.current?.close(), []);

  const loadTree = useCallback(async (root: string) => {
    setTreeLoading(true);
    try {
      const res = await apiFetch(`${SERVER_URL}/api/files?root=${encodeURIComponent(root)}`);
      const data = await res.json();
      if (data.tree) setTree(data.tree);
    } finally {
      setTreeLoading(false);
    }
  }, []);

  const loadFile = useCallback(async (root: string, path: string) => {
    const res = await apiFetch(`${SERVER_URL}/api/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (typeof data.content === "string") setFileContent(data.content);
  }, []);

  function openWorkspace(root: string, selectedModel: ModelId, options: WorkspaceOptions) {
    setProjectRoot(root);
    setModel(selectedModel);
    const socket = new AgentSocket(() => {
      socket.send({ type: "set_workspace", projectRoot: root, model: selectedModel, options });
    });
    socket.onStateChange((state) => {
      setConnection(state);
      // The server stops a running turn when its connection drops, so nothing is in flight any
      // more. What was done is replayed from the checkpoint once the socket is back.
      if (state === "reconnecting") {
        setBusy(false);
        setStreaming(false);
        setTimeline(stopRunningSubagents);
      }
    });
    socket.onMessage((msg) => {
      switch (msg.type) {
        case "workspace_ready": {
          let githubNote = "";
          if (msg.githubTools) githubNote = ` — GitHub connected (${msg.githubTools} tools)`;
          else if (options.githubToken) githubNote = " — GitHub token provided but connection failed; continuing without it";
          // Reset rather than append: this project's real history (if any) replays right
          // after this via user_message_replay/agent_message_*/tool_call_result/todo_update —
          // starting from a blank timeline is what makes that replay show a clean conversation
          // instead of stacking under whatever was on screen before.
          setTimeline([{ kind: "status", id: uid(), content: `Workspace ready: ${msg.projectRoot}${githubNote}` }]);
          setTodos([]);
          setLedger([]);
          setStreaming(false);
          userMessageCountRef.current = 0;
          waitingRef.current.clear();
          // The server may have resolved a GitHub URL into a cloned directory on its own
          // disk — everything downstream (file tree, file reads, the terminal's cwd) needs
          // that real path, not whatever the user originally typed into the picker.
          resolvedRootRef.current = msg.projectRoot;
          setProjectRoot(msg.projectRoot);
          loadTree(msg.projectRoot);
          setChangesVersion((v) => v + 1);
          break;
        }
        case "user_message_replay":
          setTimeline((t) => [...t, { kind: "user", id: uid(), content: msg.content, userIndex: userMessageCountRef.current++, timestamp: Date.now() }]);
          break;
        case "agent_thinking":
          setBusy(true);
          break;
        case "agent_message_start":
          setBusy(false);
          setTimeline((t) => [...t, { kind: "agent", id: msg.id, content: "", timestamp: Date.now() }]);
          break;
        case "agent_message_delta":
          setTimeline((t) =>
            t.map((item) => (item.id === msg.id && item.kind === "agent" ? { ...item, content: item.content + msg.delta } : item))
          );
          break;
        case "agent_message_end":
          break;
        case "tool_call_result":
          setBusy(false);
          setTimeline((t) => [...t, { kind: "tool", id: uid(), results: msg.results }]);
          if (resolvedRootRef.current) {
            loadTree(resolvedRootRef.current);
            if (selectedPathRef.current) loadFile(resolvedRootRef.current, selectedPathRef.current);
          }
          break;
        case "interrupt_request": {
          setBusy(false);
          const autoApproved = msg.actionRequests.every((a) => autoApproveRef.current.has(a.name));
          const id = msg.interruptId;
          if (!autoApproved) waitingRef.current.add(id);
          setTimeline((t) => [
            ...t,
            {
              kind: "interrupt",
              id,
              actionRequests: msg.actionRequests,
              reviewConfigs: msg.reviewConfigs,
              provenance: msg.provenance ?? [],
              resolved: autoApproved,
              decision: autoApproved ? { type: "approve" } : undefined,
            },
          ]);
          if (autoApproved) {
            socket.send({ type: "resume_decisions", interruptId: id, decisions: msg.actionRequests.map(() => ({ type: "approve" })) });
          }
          break;
        }
        case "subagent_start":
          setBusy(false);
          setTimeline((t) => {
            // Resuming after an approval starts the same task again: pick the card back up.
            if (t.some((item) => item.kind === "subagent" && item.id === msg.id)) {
              return t.map((item) => (item.kind === "subagent" && item.id === msg.id ? { ...item, status: "running" } : item));
            }
            return [...t, { kind: "subagent", id: msg.id, subagent: msg.subagent, description: msg.description, status: "running", activity: [], steps: 0 }];
          });
          break;
        case "subagent_activity":
          setTimeline((t) =>
            t.map((item) =>
              item.kind === "subagent" && item.id === msg.id
                ? { ...item, activity: [...item.activity, { tool: msg.tool, target: msg.target }].slice(-SUBAGENT_ACTIVITY_LIMIT), steps: item.steps + 1 }
                : item
            )
          );
          break;
        case "subagent_end":
          setTimeline((t) => t.map((item) => (item.kind === "subagent" && item.id === msg.id ? { ...item, status: msg.status } : item)));
          break;
        case "question_request":
          setBusy(false);
          waitingRef.current.add(msg.interruptId);
          setTimeline((t) => [...t, { kind: "question", id: msg.interruptId, question: msg.question, options: msg.options }]);
          break;
        case "todo_update":
          setTodos(msg.todos);
          break;
        case "ledger_update":
          setLedger(msg.entries);
          break;
        case "chat_cleared":
          setTimeline([{ kind: "status", id: uid(), content: "Started a new conversation." }]);
          setTodos([]);
          setLedger([]);
          setStreaming(false);
          userMessageCountRef.current = 0;
          waitingRef.current.clear();
          break;
        case "error":
          setBusy(false);
          // Also clears `streaming`: the server sends `turn_end` on every path now, but an
          // error is by definition the turn being over, and leaving this to one message
          // arriving is what previously jammed the Stop button on permanently.
          setStreaming(false);
          setTimeline((t) => [...t, { kind: "error", id: uid(), content: msg.message }]);
          break;
        case "turn_end":
          setStreaming(false);
          setTimeline(stopRunningSubagents);
          setChangesVersion((v) => v + 1);
          break;
      }
    });
    socketRef.current = socket;
  }

  // Each of these updates the screen only once the message has actually gone out, so an action
  // taken while disconnected never shows as sent.
  function handleSend(content: string) {
    if (!socketRef.current?.send({ type: "user_message", content })) return;
    setTimeline((t) => [...t, { kind: "user", id: uid(), content, userIndex: userMessageCountRef.current++, timestamp: Date.now() }]);
    setStreaming(true);
  }

  function handleEditMessage(userIndex: number, content: string) {
    if (!socketRef.current?.send({ type: "edit_message", userMessageIndex: userIndex, content })) return;
    // Drop the edited message and everything after it (its old reply, tool calls, etc.) —
    // the backend does the same truncation against the checkpointed state before resending.
    setTimeline((t) => {
      const cut = t.findIndex((item) => item.kind === "user" && item.userIndex === userIndex);
      const kept = cut === -1 ? t : t.slice(0, cut);
      return [...kept, { kind: "user", id: uid(), content, userIndex, timestamp: Date.now() }];
    });
    userMessageCountRef.current = userIndex + 1;
    setStreaming(true);
  }

  function answered(interruptId: string) {
    waitingRef.current.delete(interruptId);
    if (waitingRef.current.size === 0) setStreaming(true);
  }

  function handleDecide(interruptId: string, decisions: Decision[]) {
    if (!socketRef.current?.send({ type: "resume_decisions", interruptId, decisions })) return;
    setTimeline((t) =>
      t.map((item) => (item.id === interruptId && item.kind === "interrupt" ? { ...item, resolved: true, decision: decisions[0] } : item))
    );
    answered(interruptId);
  }

  function handleAnswer(interruptId: string, answer: string) {
    if (!socketRef.current?.send({ type: "answer_question", interruptId, answer })) return;
    setTimeline((t) => t.map((item) => (item.id === interruptId && item.kind === "question" ? { ...item, answer } : item)));
    answered(interruptId);
  }

  function handleStop() {
    socketRef.current?.send({ type: "stop" });
  }

  function handleAlwaysApprove(interruptId: string, toolNames: string[]) {
    toolNames.forEach((name) => autoApproveRef.current.add(name));
    setAutoApproveNames([...autoApproveRef.current]);
    handleDecide(
      interruptId,
      toolNames.map(() => ({ type: "approve" }))
    );
  }

  function handleForgetAutoApprove(name: string) {
    autoApproveRef.current.delete(name);
    setAutoApproveNames([...autoApproveRef.current]);
  }

  function handleClearChat() {
    socketRef.current?.send({ type: "clear_chat" });
  }

  function handleSelect(path: string) {
    setSelectedPath(path);
    selectedPathRef.current = path;
    if (projectRoot) loadFile(projectRoot, path);
  }

  function handleCloseFile() {
    setSelectedPath(null);
    selectedPathRef.current = null;
    setFileContent("");
  }

  if (!projectRoot) {
    return <WorkspacePicker onOpen={openWorkspace} />;
  }

  return (
    <div className="flex h-screen flex-col">
      <Header
        projectRoot={projectRoot}
        model={model}
        onShowSettings={() => setShowSettings(true)}
        autoApproveNames={autoApproveNames}
        onForgetAutoApprove={handleForgetAutoApprove}
      />
      <ResizablePanels
        editorActions={
          <button
            onClick={() => setTerminalOpen((o) => !o)}
            title={terminalOpen ? "Hide terminal" : "Show terminal"}
            aria-pressed={terminalOpen}
            className={`flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
              terminalOpen
                ? "bg-blue-950 light:bg-blue-50 text-blue-300 light:text-blue-800"
                : "text-neutral-400 light:text-neutral-600 hover:bg-neutral-800 light:hover:bg-neutral-100 hover:text-neutral-200 light:hover:text-neutral-800"
            }`}
          >
            <SquareTerminal className="h-3.5 w-3.5" />
            Terminal
          </button>
        }
        sidebar={
          <FileTree
            nodes={tree}
            selected={selectedPath}
            onSelect={handleSelect}
            ledger={ledger}
            loading={treeLoading}
            onRefresh={() => loadTree(projectRoot)}
          />
        }
        editor={
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">
              <Suspense fallback={<div className="p-5 text-neutral-500">Loading editor…</div>}>
                <Editor path={selectedPath} content={fileContent} onClose={handleCloseFile} />
              </Suspense>
            </div>
            {terminalOpen && (
              <div className="h-64 max-h-[70vh] min-h-[120px] flex-none resize-y overflow-hidden">
                <Suspense fallback={<div className="p-2 text-xs text-neutral-500">Loading terminal…</div>}>
                  <TerminalPanel projectRoot={projectRoot} onClose={() => setTerminalOpen(false)} />
                </Suspense>
              </div>
            )}
          </div>
        }
        chat={
          <>
            <ChatHeader onNewChat={handleClearChat} />
            <TodoPanel todos={todos} />
            <LedgerPanel entries={ledger} />
            {projectRoot && <ChangesPanel projectRoot={projectRoot} refreshKey={changesVersion} />}
            <ChatPanel
              timeline={timeline}
              busy={busy}
              streaming={streaming}
              connected={connection === "open"}
              projectRoot={projectRoot}
              onSend={handleSend}
              onStop={handleStop}
              onDecide={handleDecide}
              onAnswer={handleAnswer}
              onAlwaysApprove={handleAlwaysApprove}
              onEditMessage={handleEditMessage}
            />
          </>
        }
      />
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
    </div>
  );
}
