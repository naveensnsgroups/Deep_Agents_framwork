import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";

interface Props {
  sidebar: ReactNode;
  editor: ReactNode;
  chat: ReactNode;
  /** Buttons for the editor area's own bar, after the Files toggle (e.g. the terminal toggle). */
  editorActions?: ReactNode;
}

const MIN_SIDEBAR = 160;
const MIN_CHAT = 280;
const MIN_EDITOR = 240;
const DIVIDER = 4;

const STORAGE_KEY = "deepagents:panelWidths";

function loadSaved(): { sidebarWidth?: number; chatWidth?: number } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveWidths(sidebarWidth: number, chatWidth: number) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sidebarWidth, chatWidth }));
  } catch {
    // private browsing / storage disabled — not fatal, just no persistence
  }
}

export function ResizablePanels({ sidebar, editor, chat, editorActions }: Props) {
  const saved = loadSaved();
  const [sidebarWidth, setSidebarWidth] = useState(saved.sidebarWidth ?? 240);
  const [chatWidth, setChatWidth] = useState(saved.chatWidth ?? 420);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);
  const dragging = useRef<"sidebar" | "chat" | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const onMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (dragging.current === "sidebar") {
      const next = e.clientX - rect.left;
      setSidebarWidth(Math.max(MIN_SIDEBAR, Math.min(next, rect.width - MIN_CHAT - MIN_EDITOR)));
    } else {
      const next = rect.right - e.clientX;
      setChatWidth(Math.max(MIN_CHAT, Math.min(next, rect.width - MIN_SIDEBAR - MIN_EDITOR)));
    }
  }, []);

  useEffect(() => {
    const stop = () => {
      if (dragging.current) saveWidths(sidebarWidth, chatWidth);
      dragging.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", stop);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", stop);
    };
  }, [onMouseMove, sidebarWidth, chatWidth]);

  // Sidebar and chat are fixed pixel widths; without this, shrinking the window (or
  // undocking to a smaller display) took the space only from the editor — measured
  // dropping to ~92px at a 760px window while both fixed panels stayed full size. Shrink
  // chat first (down to its own minimum), then sidebar, so the editor never loses ground
  // to two panels that both still have room to give.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const clamp = () => {
      if (dragging.current) return; // the drag handler already keeps things in bounds live
      const containerWidth = container.getBoundingClientRect().width;
      const dividers = (sidebarOpen ? DIVIDER : 0) + (chatOpen ? DIVIDER : 0);
      let sw = sidebarOpen ? sidebarWidth : 0;
      let cw = chatOpen ? chatWidth : 0;
      let deficit = MIN_EDITOR - (containerWidth - dividers - sw - cw);
      if (deficit <= 0) return;

      if (chatOpen) {
        const shrink = Math.min(cw - MIN_CHAT, deficit);
        if (shrink > 0) {
          cw -= shrink;
          deficit -= shrink;
        }
      }
      if (deficit > 0 && sidebarOpen) {
        const shrink = Math.min(sw - MIN_SIDEBAR, deficit);
        if (shrink > 0) {
          sw -= shrink;
          deficit -= shrink;
        }
      }
      // If a deficit remains here, the window is narrower than all three minimums combined
      // (below ~688px) — the editor's own min-width below takes over and the row overflows
      // rather than crushing any panel further; that is an honest degrade for a window this
      // narrow, not a silent auto-close of a panel the user didn't ask to close.
      if (chatOpen && cw !== chatWidth) setChatWidth(cw);
      if (sidebarOpen && sw !== sidebarWidth) setSidebarWidth(sw);
    };

    clamp();
    const observer = new ResizeObserver(clamp);
    observer.observe(container);
    return () => observer.disconnect();
  }, [sidebarOpen, chatOpen, sidebarWidth, chatWidth]);

  function startDrag(which: "sidebar" | "chat") {
    dragging.current = which;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1">
      {sidebarOpen && (
        <>
          {/* No overflow-y-auto here — FileTree owns its own scroll region internally so
              its filter toolbar can stay sticky, rather than scrolling away with the list. */}
          <div style={{ width: sidebarWidth }} className="h-full min-h-0 min-w-0 shrink-0 bg-neutral-900 light:bg-neutral-50 text-neutral-300 light:text-neutral-700">
            {sidebar}
          </div>
          <div
            onMouseDown={() => startDrag("sidebar")}
            className="w-1 shrink-0 cursor-col-resize bg-neutral-800 light:bg-neutral-100 transition-colors hover:bg-blue-600"
          />
        </>
      )}

      <div className="flex min-w-[240px] flex-1 flex-col overflow-hidden">
        <div className="flex flex-none items-center gap-2 border-b border-neutral-800 light:border-neutral-200 bg-neutral-900 light:bg-neutral-50 px-2 py-1">
          <button
            onClick={() => setSidebarOpen((o) => !o)}
            title={sidebarOpen ? "Hide file tree" : "Show file tree"}
            className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-neutral-400 light:text-neutral-600 hover:bg-neutral-800 light:hover:bg-neutral-100 hover:text-neutral-200 light:hover:text-neutral-800"
          >
            {sidebarOpen ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeftOpen className="h-3.5 w-3.5" />}
            Files
          </button>
          {editorActions}
          <div className="flex-1" />
          {/* Icon only while the chat is open: its own bar already says "Chat" right beside this. */}
          <button
            onClick={() => setChatOpen((o) => !o)}
            title={chatOpen ? "Hide chat" : "Show chat"}
            aria-label={chatOpen ? "Hide chat" : "Show chat"}
            className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-neutral-400 light:text-neutral-600 hover:bg-neutral-800 light:hover:bg-neutral-100 hover:text-neutral-200 light:hover:text-neutral-800"
          >
            {!chatOpen && "Chat"}
            {chatOpen ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRightOpen className="h-3.5 w-3.5" />}
          </button>
        </div>
        <div className="min-h-0 flex-1">{editor}</div>
      </div>

      {chatOpen && (
        <>
          <div
            onMouseDown={() => startDrag("chat")}
            className="w-1 shrink-0 cursor-col-resize bg-neutral-800 light:bg-neutral-100 transition-colors hover:bg-blue-600"
          />
          <div style={{ width: chatWidth }} className="flex min-w-0 shrink-0 flex-col">
            {chat}
          </div>
        </>
      )}
    </div>
  );
}
