import { useEffect, useRef, useState } from "react";
import { Pencil, Check, X, SendHorizontal, Copy, CopyCheck, Square } from "lucide-react";
import type { Decision, TimelineItem } from "../../types";
import { ToolCallCard } from "./ToolCallCard";
import { ToolBlock } from "./ToolBlock";
import { Markdown } from "./Markdown";
import { ErrorBlock } from "./ErrorBlock";

interface Props {
  timeline: TimelineItem[];
  busy: boolean;
  streaming: boolean;
  projectRoot: string;
  onSend: (content: string) => void;
  onStop: () => void;
  onDecide: (interruptId: string, decisions: Decision[]) => void;
  onAlwaysApprove: (interruptId: string, toolNames: string[]) => void;
  onEditMessage: (userIndex: number, content: string) => void;
}

const STARTERS = [
  "Analyse this project and tell me what stack it uses",
  "Plan a migration of this API to FastAPI",
  "Which files depend on each other? Give me a migration order",
];

/** Fills the otherwise-blank panel before the first message with something actionable. */
function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-col gap-2 py-2">
      <p className="text-[13px] text-neutral-400">Start with one of these, or type your own:</p>
      {STARTERS.map((s) => (
        <button
          key={s}
          onClick={() => onPick(s)}
          className="cursor-pointer rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-2 text-left text-[13px] leading-snug text-neutral-300 hover:border-neutral-700 hover:text-neutral-100"
        >
          {s}
        </button>
      ))}
    </div>
  );
}

export function ChatPanel({ timeline, busy, streaming, projectRoot, onSend, onStop, onDecide, onAlwaysApprove, onEditMessage }: Props) {
  const [draft, setDraft] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function copyText(text: string, id: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500);
    });
  }

  // Grow with the text instead of scrolling inside a fixed 44px box, which cut off
  // anything past the first line and left a scrollbar sitting in the input.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    // border-box sizing means the borders come out of the content area, so height must
    // include them or the last line stays 2px short and keeps a scrollbar.
    const borders = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + borders, 160)}px`;
  }, [draft]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [timeline.length, busy]);

  // The workspace-ready line is a status item, so an untouched chat is not empty —
  // it just has nothing worth reading yet.
  const hasConversation = timeline.some((item) => item.kind !== "status");

  function submit() {
    const content = draft.trim();
    if (!content) return;
    onSend(content);
    setDraft("");
  }

  function startEdit(userIndex: number, content: string) {
    setEditingIndex(userIndex);
    setEditDraft(content);
  }

  function cancelEdit() {
    setEditingIndex(null);
    setEditDraft("");
  }

  function saveEdit(userIndex: number) {
    const content = editDraft.trim();
    if (!content) return;
    onEditMessage(userIndex, content);
    setEditingIndex(null);
    setEditDraft("");
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
        {timeline.map((item) => {
          switch (item.kind) {
            case "user":
              if (editingIndex === item.userIndex) {
                return (
                  <div key={item.id} className="flex w-[92%] flex-col items-end self-end gap-1.5">
                    <textarea
                      autoFocus
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          saveEdit(item.userIndex);
                        } else if (e.key === "Escape") {
                          cancelEdit();
                        }
                      }}
                      className="w-full resize-none rounded-md border border-blue-700 bg-neutral-900 p-2 font-sans text-[13px] text-neutral-100 outline-none"
                      rows={Math.min(6, Math.max(2, editDraft.split("\n").length))}
                    />
                    <div className="flex gap-1.5">
                      <button
                        onClick={cancelEdit}
                        title="Cancel"
                        className="flex cursor-pointer items-center gap-1 rounded-md border border-neutral-700 bg-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-700"
                      >
                        <X className="h-3 w-3" />
                        Cancel
                      </button>
                      <button
                        onClick={() => saveEdit(item.userIndex)}
                        disabled={!editDraft.trim()}
                        title="Save and resend (discards everything after this message)"
                        className="flex cursor-pointer items-center gap-1 rounded-md bg-blue-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
                      >
                        <Check className="h-3 w-3" />
                        Save &amp; resend
                      </button>
                    </div>
                  </div>
                );
              }
              return (
                <div key={item.id} className="group flex max-w-[92%] flex-col items-end self-end">
                  <span className="mb-0.5 text-[10px] text-neutral-600 opacity-0 transition-opacity group-hover:opacity-100">
                    {formatTime(item.timestamp)}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => startEdit(item.userIndex, item.content)}
                      disabled={busy}
                      title="Edit and resend"
                      className="cursor-pointer text-neutral-600 opacity-0 transition-opacity hover:text-neutral-300 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <div className="whitespace-pre-wrap rounded-lg bg-blue-900/70 px-2.5 py-2 text-[13px] leading-relaxed text-neutral-100">
                      {item.content}
                    </div>
                  </div>
                </div>
              );
            case "agent":
              return (
                <div key={item.id} className="group flex max-w-full flex-col self-stretch">
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className="text-[10px] uppercase tracking-wide text-neutral-500">Agent</span>
                    <span className="text-[10px] text-neutral-600 opacity-0 transition-opacity group-hover:opacity-100">
                      {formatTime(item.timestamp)}
                    </span>
                    {item.content && (
                      <button
                        onClick={() => copyText(item.content, item.id)}
                        title="Copy message"
                        className="cursor-pointer text-neutral-600 opacity-0 transition-opacity hover:text-neutral-300 group-hover:opacity-100"
                      >
                        {copiedId === item.id ? <CopyCheck className="h-3 w-3 text-green-400" /> : <Copy className="h-3 w-3" />}
                      </button>
                    )}
                  </div>
                  <div className="max-w-full overflow-hidden rounded-lg bg-neutral-800 px-2.5 py-2">
                    <Markdown content={item.content} />
                  </div>
                </div>
              );
            case "status":
              return (
                <div key={item.id} className="break-words text-[13px] italic text-neutral-500">
                  {item.content}
                </div>
              );
            case "error":
              return (
                <div key={item.id} className="max-w-full">
                  <ErrorBlock content={item.content} />
                </div>
              );
            case "tool":
              return (
                <div key={item.id} className="flex max-w-full flex-col self-stretch">
                  {item.results.map((r, i) => (
                    <ToolBlock key={i} result={r} />
                  ))}
                </div>
              );
            case "interrupt":
              return (
                <div key={item.id} className="flex max-w-full flex-col self-stretch">
                  <ToolCallCard
                    actionRequests={item.actionRequests}
                    reviewConfigs={item.reviewConfigs}
                    resolved={item.resolved}
                    projectRoot={projectRoot}
                    onDecide={(decisions) => onDecide(item.id, decisions)}
                    onAlwaysApprove={() => onAlwaysApprove(item.id, item.actionRequests.map((a) => a.name))}
                  />
                </div>
              );
          }
        })}
        {!hasConversation && !busy && <EmptyState onPick={(text) => setDraft(text)} />}
        {busy && <div className="text-[13px] italic text-neutral-500">Agent is working…</div>}
      </div>
      <div className="flex-none border-t border-neutral-800 p-2.5">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Ask the agent…"
            disabled={busy}
            className="max-h-40 min-h-[36px] flex-1 resize-none overflow-y-auto rounded-md border border-neutral-700 bg-neutral-900 px-2 py-2 font-sans text-[13px] leading-snug text-neutral-100 outline-none focus:border-blue-500 disabled:opacity-60"
          />
          {streaming ? (
            <button
              onClick={onStop}
              title="Stop — halts further model output and tool calls. A shell command already running may keep going in the background."
              className="flex h-9 flex-none cursor-pointer items-center justify-center rounded-md bg-red-600 px-3 text-white hover:bg-red-500"
            >
              <Square className="h-3.5 w-3.5" fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={busy || !draft.trim()}
              title="Send (Enter)"
              className="flex h-9 flex-none cursor-pointer items-center justify-center rounded-md bg-blue-600 px-3 text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-500"
            >
              <SendHorizontal className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
