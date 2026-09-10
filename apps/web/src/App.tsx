import { useCallback, useRef, useState } from "react";
import type { FileNode, LedgerEntry, ModelId, Todo, WorkspaceOptions } from "@deepagents-ide/shared";
import { WorkspacePicker } from "./components/workspace/WorkspacePicker";
import { FileTree } from "./components/editor/FileTree";
import { Editor } from "./components/editor/Editor";
import { ChatPanel } from "./components/chat/ChatPanel";
import { TodoPanel } from "./components/chat/TodoPanel";
import { LedgerPanel } from "./components/chat/LedgerPanel";
import { Header } from "./components/layout/Header";
import { SystemInfoPanel } from "./components/layout/SystemInfoPanel";
import { ResizablePanels } from "./components/layout/ResizablePanels";
import { AgentSocket, SERVER_URL } from "./lib/ws-client";
import type { Decision, TimelineItem } from "./types";

function uid() {
  return crypto.randomUUID();
}

export default function App() {
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [model, setModel] = useState<ModelId>("");
  const [showInfo, setShowInfo] = useState(false);
  const [autoApproveNames, setAutoApproveNames] = useState<string[]>([]);
  const socketRef = useRef<AgentSocket | null>(null);
  const selectedPathRef = useRef<string | null>(null);
  const autoApproveRef = useRef<Set<string>>(new Set());
  // Counts human messages in arrival order so an edit can identify — and the backend can
  // truncate from — the exact turn being edited, the same way it counts "human" messages
  // in the checkpointed LangGraph state.
  const userMessageCountRef = useRef(0);

  const loadTree = useCallback(async (root: string) => {
    setTreeLoading(true);
    try {
      const res = await fetch(`${SERVER_URL}/api/files?root=${encodeURIComponent(root)}`);
      const data = await res.json();
      if (data.tree) setTree(data.tree);
    } finally {
      setTreeLoading(false);
    }
  }, []);

  const loadFile = useCallback(async (root: string, path: string) => {
    const res = await fetch(`${SERVER_URL}/api/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (typeof data.content === "string") setFileContent(data.content);
  }, []);

  function openWorkspace(root: string, selectedModel: ModelId, options: WorkspaceOptions) {
    setProjectRoot(root);
    setModel(selectedModel);
    const socket = new AgentSocket(() => {
      socket.send({ type: "set_workspace", projectRoot: root, model: selectedModel, options });
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
          userMessageCountRef.current = 0;
          loadTree(msg.projectRoot);
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
          loadTree(root);
          if (selectedPathRef.current) loadFile(root, selectedPathRef.current);
          break;
        case "interrupt_request": {
          setBusy(false);
          const autoApproved = msg.actionRequests.every((a) => autoApproveRef.current.has(a.name));
          const id = uid();
          setTimeline((t) => [
            ...t,
            { kind: "interrupt", id, actionRequests: msg.actionRequests, reviewConfigs: msg.reviewConfigs, resolved: autoApproved },
          ]);
          if (autoApproved) {
            socket.send({ type: "resume_decisions", decisions: msg.actionRequests.map(() => ({ type: "approve" })) });
          }
          break;
        }
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
          userMessageCountRef.current = 0;
          break;
        case "error":
          setBusy(false);
          setTimeline((t) => [...t, { kind: "error", id: uid(), content: msg.message }]);
          break;
      }
    });
    socketRef.current = socket;
  }

  function handleSend(content: string) {
    setTimeline((t) => [...t, { kind: "user", id: uid(), content, userIndex: userMessageCountRef.current++, timestamp: Date.now() }]);
    socketRef.current?.send({ type: "user_message", content });
  }

  function handleEditMessage(userIndex: number, content: string) {
    // Drop the edited message and everything after it (its old reply, tool calls, etc.) —
    // the backend does the same truncation against the checkpointed state before resending.
    setTimeline((t) => {
      const cut = t.findIndex((item) => item.kind === "user" && item.userIndex === userIndex);
      const kept = cut === -1 ? t : t.slice(0, cut);
      return [...kept, { kind: "user", id: uid(), content, userIndex, timestamp: Date.now() }];
    });
    userMessageCountRef.current = userIndex + 1;
    socketRef.current?.send({ type: "edit_message", userMessageIndex: userIndex, content });
  }

  function handleDecide(interruptId: string, decisions: Decision[]) {
    setTimeline((t) => t.map((item) => (item.id === interruptId && item.kind === "interrupt" ? { ...item, resolved: true } : item)));
    socketRef.current?.send({ type: "resume_decisions", decisions });
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
        onShowInfo={() => setShowInfo(true)}
        onClearChat={handleClearChat}
        autoApproveNames={autoApproveNames}
        onForgetAutoApprove={handleForgetAutoApprove}
      />
      <ResizablePanels
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
        editor={<Editor path={selectedPath} content={fileContent} onClose={handleCloseFile} />}
        chat={
          <>
            <TodoPanel todos={todos} />
            <LedgerPanel entries={ledger} />
            <ChatPanel
              timeline={timeline}
              busy={busy}
              onSend={handleSend}
              onDecide={handleDecide}
              onAlwaysApprove={handleAlwaysApprove}
              onEditMessage={handleEditMessage}
            />
          </>
        }
      />
      {showInfo && <SystemInfoPanel onClose={() => setShowInfo(false)} />}
    </div>
  );
}
