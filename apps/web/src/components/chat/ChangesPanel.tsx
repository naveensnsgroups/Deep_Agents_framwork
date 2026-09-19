import { lazy, Suspense, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import type { ChangedFile, WorkspaceChanges } from "@deepagents-ide/shared";
import { SERVER_URL } from "../../lib/ws-client";
import { apiFetch } from "../../lib/auth";
import { useFileLanguage } from "../../lib/useFileLanguage";

const DiffMergeEditor = lazy(() => import("./DiffMergeEditor").then((m) => ({ default: m.DiffMergeEditor })));

interface Props {
  projectRoot: string;
  /** Changes whenever the files may have changed (a workspace opened, a run ended), to fetch the list again. */
  refreshKey: number;
}

const STATUS: Record<ChangedFile["status"], { letter: string; label: string; className: string }> = {
  added: { letter: "A", label: "added", className: "text-green-500 light:text-green-700" },
  modified: { letter: "M", label: "modified", className: "text-amber-400 light:text-amber-700" },
  deleted: { letter: "D", label: "deleted", className: "text-red-400 light:text-red-600" },
  renamed: { letter: "R", label: "renamed", className: "text-sky-400 light:text-sky-700" },
};

function query(root: string, path?: string): string {
  const params = new URLSearchParams({ root });
  if (path !== undefined) params.set("path", path);
  return params.toString();
}

type Diff = { original: string; modified: string } | { unavailable: string };

async function loadDiff(root: string, file: ChangedFile): Promise<Diff> {
  const committedPath = file.status === "renamed" && file.from ? file.from : file.path;
  const [original, modified] = await Promise.all([
    file.status === "added"
      ? Promise.resolve<string | null>("")
      : apiFetch(`${SERVER_URL}/api/changes/original?${query(root, committedPath)}`)
          .then((r) => r.json())
          .then((d: { content?: string | null }) => d.content ?? null),
    file.status === "deleted"
      ? Promise.resolve("")
      : apiFetch(`${SERVER_URL}/api/file?${query(root, file.path)}`)
          .then((r) => r.json())
          .then((d: { content?: string }) => d.content ?? ""),
  ]);
  if (original === null) return { unavailable: "No preview — the file is binary or too large to compare." };
  return { original, modified };
}

function FileDiff({ projectRoot, file }: { projectRoot: string; file: ChangedFile }) {
  const [diff, setDiff] = useState<Diff | null>(null);
  const language = useFileLanguage(file.path);

  useEffect(() => {
    let current = true;
    loadDiff(projectRoot, file)
      .then((d) => current && setDiff(d))
      .catch(() => current && setDiff({ unavailable: "Could not load this file." }));
    return () => {
      current = false;
    };
  }, [projectRoot, file]);

  const placeholder = (text: string) => <div className="py-1 pl-4 text-[11px] text-neutral-500">{text}</div>;
  if (!diff) return placeholder("Loading…");
  if ("unavailable" in diff) return placeholder(diff.unavailable);
  return (
    <div className="mt-1 mb-2">
      <Suspense fallback={placeholder("Loading…")}>
        <DiffMergeEditor original={diff.original} modified={diff.modified} language={language} />
      </Suspense>
    </div>
  );
}

/**
 * Every file that differs from the last commit — what the agent, its subagents and any command
 * they ran changed. Hidden until there is something to show.
 */
export function ChangesPanel({ projectRoot, refreshKey }: Props) {
  const [changes, setChanges] = useState<WorkspaceChanges | null>(null);
  const [open, setOpen] = useState(false);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [manualRefresh, setManualRefresh] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let current = true;
    setLoading(true);
    apiFetch(`${SERVER_URL}/api/changes?${query(projectRoot)}`)
      .then((r) => r.json())
      .then((data: WorkspaceChanges) => {
        if (!current || !Array.isArray(data.files)) return;
        setChanges(data);
        // A file that is no longer changed has nothing left to show.
        setOpenPath((p) => (p && data.files.some((f) => f.path === p) ? p : null));
      })
      .catch(() => {})
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [projectRoot, refreshKey, manualRefresh]);

  if (!changes?.available || changes.files.length === 0) return null;

  const counts = changes.files.reduce<Partial<Record<ChangedFile["status"], number>>>((acc, f) => {
    acc[f.status] = (acc[f.status] ?? 0) + 1;
    return acc;
  }, {});
  const total = changes.truncated ?? changes.files.length;

  return (
    <div className="flex-none border-b border-neutral-800 light:border-neutral-200 px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <button onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left">
          {open ? <ChevronDown className="h-3 w-3 flex-none text-neutral-500" /> : <ChevronRight className="h-3 w-3 flex-none text-neutral-500" />}
          <span className="text-[11px] uppercase tracking-wide text-neutral-500">Changes ({total})</span>
          <span className="ml-auto flex items-center gap-2">
            {(Object.keys(STATUS) as ChangedFile["status"][])
              .filter((s) => counts[s])
              .map((s) => (
                <span key={s} title={`${counts[s]} ${STATUS[s].label}`} className={`font-mono text-[11px] ${STATUS[s].className}`}>
                  {STATUS[s].letter} {counts[s]}
                </span>
              ))}
          </span>
        </button>
        <button
          onClick={() => setManualRefresh((n) => n + 1)}
          title="Refresh"
          aria-label="Refresh changes"
          className="flex-none cursor-pointer rounded p-0.5 text-neutral-500 hover:text-neutral-300 light:hover:text-neutral-700"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {open && (
        <div className="mt-1.5 max-h-96 overflow-y-auto">
          {changes.files.map((file) => {
            const meta = STATUS[file.status];
            const expanded = openPath === file.path;
            return (
              <div key={file.path}>
                <button
                  onClick={() => setOpenPath(expanded ? null : file.path)}
                  className="flex w-full cursor-pointer items-start gap-1.5 py-0.5 text-left text-xs hover:bg-neutral-900 light:hover:bg-neutral-100"
                >
                  <span title={meta.label} className={`w-3 flex-none font-mono ${meta.className}`}>
                    {meta.letter}
                  </span>
                  <span className="break-all text-neutral-300 light:text-neutral-700">
                    {file.from ? <span className="text-neutral-500">{file.from} → </span> : null}
                    {file.path}
                  </span>
                </button>
                {expanded && <FileDiff projectRoot={projectRoot} file={file} />}
              </div>
            );
          })}
          {changes.truncated ? (
            <div className="py-1 text-[11px] text-neutral-500">
              Showing the first {changes.files.length} of {changes.truncated} files.
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
