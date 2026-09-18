import { lazy, Suspense, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Pencil, ShieldCheck, X } from "lucide-react";
import type { ActionRequest, ReadProvenance, ReviewConfig } from "@deepagents-ide/shared";
import type { Decision } from "../../types";
import { ToolIcon } from "../../lib/toolIcons";
import { ToolActionBody } from "./ToolActionBody";
import { SERVER_URL } from "../../lib/ws-client";
import { apiFetch } from "../../lib/auth";
import { fileNameOf } from "../../lib/fileTypes";
import { ProvenancePanel } from "./ProvenancePanel";

// Only opened when a reviewer edits a pending write, so Monaco stays out of the chat's own load.
const DiffMergeEditor = lazy(() => import("./DiffMergeEditor").then((m) => ({ default: m.DiffMergeEditor })));

interface Props {
  actionRequests: ActionRequest[];
  reviewConfigs: ReviewConfig[];
  /** Files read just before this action was proposed. Optional so non-interrupt uses of
   * this card (a plain tool result) need not supply it. */
  provenance?: ReadProvenance[];
  resolved: boolean;
  projectRoot: string;
  onDecide: (decisions: Decision[]) => void;
  onAlwaysApprove: () => void;
}

/** Same registry Monaco itself ships, looked up by extension — same approach as useFileLanguage,
 * but usable outside a component tree already wrapped by @monaco-editor/react's loader hook. */
function guessLanguage(path: string): string {
  const ext = fileNameOf(path).toLowerCase().split(".").pop() ?? "";
  const known: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    yml: "yaml",
    yaml: "yaml",
    go: "go",
    rs: "rust",
    java: "java",
  };
  return known[ext] ?? "plaintext";
}

function actionSummary(action: ActionRequest): string {
  const target = action.args.file_path ?? action.args.path ?? action.args.command;
  return typeof target === "string" ? target : "";
}

export function ToolCallCard({ actionRequests, reviewConfigs, provenance, resolved, projectRoot, onDecide, onAlwaysApprove }: Props) {
  const [editing, setEditing] = useState(false);
  const [draftArgs, setDraftArgs] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // Only set when the action being edited is a write_file/edit_file — drives the Monaco
  // diff editor instead of the raw-JSON textarea fallback.
  const [diffDraft, setDiffDraft] = useState<{ original: string; modified: string; language: string } | null>(null);

  const singleAction = actionRequests.length === 1 ? actionRequests[0] : null;
  const canEdit =
    singleAction != null && (reviewConfigs.find((rc) => rc.actionName === singleAction.name)?.allowedDecisions.includes("edit") ?? false);

  async function startEdit() {
    if (!singleAction) return;
    setEditError(null);
    setDiffDraft(null);
    const { name, args } = singleAction;
    const filePath = typeof args.file_path === "string" ? args.file_path : "";

    if (name === "edit_file" && typeof args.old_string === "string" && typeof args.new_string === "string") {
      setDiffDraft({ original: args.old_string, modified: args.new_string, language: guessLanguage(filePath) });
    } else if (name === "write_file" && typeof args.content === "string") {
      // Best-effort "before" — the file may not exist yet (a new file), in which case an
      // empty original correctly renders the whole thing as an addition.
      let original = "";
      try {
        const res = await apiFetch(`${SERVER_URL}/api/file?root=${encodeURIComponent(projectRoot)}&path=${encodeURIComponent(filePath)}`);
        const data = await res.json();
        if (typeof data.content === "string") original = data.content;
      } catch {
        // stays "" — network hiccup or genuinely new file, either way don't block editing
      }
      setDiffDraft({ original, modified: args.content, language: guessLanguage(filePath) });
    } else {
      setDraftArgs(JSON.stringify(args, null, 2));
    }
    setEditing(true);
  }

  function saveEdit() {
    if (!singleAction) return;
    if (diffDraft) {
      const field = singleAction.name === "edit_file" ? "new_string" : "content";
      onDecide([{ type: "edit", editedAction: { name: singleAction.name, args: { ...singleAction.args, [field]: diffDraft.modified } } }]);
      setEditing(false);
      return;
    }
    try {
      const args = JSON.parse(draftArgs) as Record<string, unknown>;
      onDecide([{ type: "edit", editedAction: { name: singleAction.name, args } }]);
      setEditing(false);
    } catch {
      setEditError("Invalid JSON");
    }
  }

  // Once handled, this is history, not something needing attention — collapse it to a
  // muted one-liner instead of keeping the loud "needs approval" amber treatment.
  if (resolved) {
    return (
      <div className="overflow-hidden rounded-md border border-neutral-800">
        <button
          className="flex w-full cursor-pointer items-center gap-2 border-none bg-neutral-900 px-2.5 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-800"
          onClick={() => setExpanded((e) => !e)}
        >
          {actionRequests.map((action, i) => (
            <span key={i} className="flex items-center gap-1">
              <ToolIcon name={action.name} className="h-3.5 w-3.5 text-neutral-400" />
              <span className="font-semibold">{action.name}</span>
            </span>
          ))}
          <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-neutral-500">
            {actionRequests.map(actionSummary).filter(Boolean).join(", ")}
          </span>
          {expanded ? <ChevronDown className="h-3.5 w-3.5 text-neutral-600" /> : <ChevronRight className="h-3.5 w-3.5 text-neutral-600" />}
        </button>
        {expanded && (
          <div className="border-t border-neutral-800 bg-neutral-950 px-2.5 py-2">
            {actionRequests.map((action, i) => (
              <ToolActionBody key={i} name={action.name} args={action.args} />
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-900 bg-amber-950/40 p-2.5">
      {actionRequests.map((action, i) => (
        <div key={i} className="mb-2 last:mb-0">
          <div className="mb-1 flex items-center gap-1.5 font-semibold text-amber-200">
            <AlertTriangle className="h-4 w-4 flex-none" />
            {action.name}
          </div>
          {editing && singleAction === action && diffDraft ? (
            <Suspense fallback={<div className="h-56 rounded border border-amber-800 p-2 text-xs text-neutral-500">Loading diff…</div>}>
              <DiffMergeEditor
                original={diffDraft.original}
                modified={diffDraft.modified}
                language={diffDraft.language}
                onChange={(modified) => setDiffDraft((d) => (d ? { ...d, modified } : d))}
              />
            </Suspense>
          ) : editing && singleAction === action ? (
            <textarea
              value={draftArgs}
              onChange={(e) => setDraftArgs(e.target.value)}
              className="h-32 w-full resize-y rounded border border-amber-800 bg-neutral-950 p-1.5 font-mono text-xs text-neutral-100 outline-none"
            />
          ) : (
            <div className="rounded bg-neutral-950 p-1.5 text-neutral-200">
              <ToolActionBody name={action.name} args={action.args} />
            </div>
          )}
        </div>
      ))}
      {editError && <div className="mb-2 text-xs text-red-400">{editError}</div>}
      {editing ? (
        <div className="flex gap-2">
          <button
            className="flex cursor-pointer items-center gap-1.5 rounded-md border-none bg-green-700 px-3 py-1.5 text-white hover:bg-green-600"
            onClick={saveEdit}
          >
            <Check className="h-3.5 w-3.5" />
            Save &amp; Approve
          </button>
          <button
            className="cursor-pointer rounded-md border border-neutral-600 bg-transparent px-3 py-1.5 text-neutral-300 hover:bg-neutral-800"
            onClick={() => setEditing(false)}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {/* Above the buttons deliberately: this is context for the decision, so it has to
              be readable before the hand reaches Approve, not discovered afterwards. */}
          {provenance && provenance.length > 0 ? <ProvenancePanel provenance={provenance} /> : null}

          {/* Primary decision — the two actions that resolve the interrupt — get the top
              row to themselves so they never wrap under the wider "Always Approve" label
              (measured overflowing a 420px chat panel before this fix). Always Approve and
              Edit are secondary/less frequent and sit below, still fully visible rather
              than hidden behind a menu — this is a safety-relevant decision, so nothing
              here should require an extra click just to discover it exists. */}
          <div className="flex gap-2">
            <button
              className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border-none bg-green-700 py-1.5 text-white hover:bg-green-600"
              onClick={() => onDecide(actionRequests.map(() => ({ type: "approve" })))}
            >
              <Check className="h-3.5 w-3.5" />
              Approve
            </button>
            <button
              className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border-none bg-red-800 py-1.5 text-white hover:bg-red-700"
              onClick={() => onDecide(actionRequests.map(() => ({ type: "reject", message: "Denied by user" })))}
            >
              <X className="h-3.5 w-3.5" />
              Deny
            </button>
          </div>
          <div className="flex gap-2">
            <button
              title="Approve this and auto-approve this tool for the rest of the session"
              className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-green-800 bg-transparent py-1 text-[11px] text-green-400 hover:bg-green-950"
              onClick={onAlwaysApprove}
            >
              <ShieldCheck className="h-3 w-3" />
              Always Approve
            </button>
            {canEdit && (
              <button
                className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-neutral-600 bg-transparent py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
                onClick={startEdit}
              >
                <Pencil className="h-3 w-3" />
                Edit
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
