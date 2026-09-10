import { useEffect, useState } from "react";
import { ArrowUp, Folder, X } from "lucide-react";
import type { BrowseEntry } from "@deepagents-ide/shared";
import { SERVER_URL } from "../../lib/ws-client";

interface Props {
  /** Where to start browsing. Omit to start at the drive/root list. */
  initialPath?: string;
  title: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}

interface BrowseResult {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
}

export function FolderBrowserModal({ initialPath, title, onSelect, onClose }: Props) {
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualPath, setManualPath] = useState(initialPath ?? "");

  function load(path: string) {
    setError(null);
    fetch(`${SERVER_URL}/api/browse?path=${encodeURIComponent(path)}`)
      .then((res) => res.json())
      .then((data: BrowseResult | { error: string }) => {
        if ("error" in data) {
          setError(data.error);
          return;
        }
        setResult(data);
        setManualPath(data.path);
      })
      .catch(() => setError("Could not reach the server"));
  }

  useEffect(() => {
    load(initialPath ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="flex max-h-[75vh] w-[min(560px,92vw)] flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <h2 className="text-sm font-semibold text-neutral-100">{title}</h2>
          <button onClick={onClose} className="cursor-pointer border-none bg-transparent text-neutral-400 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex gap-2 border-b border-neutral-800 px-4 py-2.5">
          <input
            type="text"
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load(manualPath)}
            placeholder="Type a path or browse below"
            className="flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 font-mono text-xs text-neutral-100 outline-none focus:border-blue-500"
          />
          <button
            onClick={() => load(manualPath)}
            className="cursor-pointer rounded-md border border-neutral-700 bg-neutral-800 px-3 text-xs text-neutral-200 hover:bg-neutral-700"
          >
            Go
          </button>
        </div>

        <div className="min-h-[240px] flex-1 overflow-y-auto px-2 py-2">
          {error && <div className="px-2 py-1 text-xs text-red-400">{error}</div>}
          {result && (
            <>
              {result.parent !== null && (
                <button
                  onClick={() => load(result.parent as string)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-neutral-300 hover:bg-neutral-800"
                >
                  <ArrowUp className="h-4 w-4 text-neutral-500" />
                  <span>.. (up)</span>
                </button>
              )}
              {result.entries.length === 0 && (
                <div className="px-2 py-4 text-center text-xs text-neutral-500">No subfolders here</div>
              )}
              {result.entries.map((entry) => (
                <button
                  key={entry.path}
                  onClick={() => load(entry.path)}
                  className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-800"
                >
                  <Folder className="h-4 w-4 flex-none text-blue-400" />
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap">{entry.name}</span>
                </button>
              ))}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-neutral-800 px-4 py-3">
          <span className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] text-neutral-500">
            {result?.path || "No folder selected"}
          </span>
          <div className="flex flex-none gap-2">
            <button
              onClick={onClose}
              className="cursor-pointer rounded-md border border-neutral-600 bg-transparent px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              disabled={!result?.path}
              onClick={() => result && onSelect(result.path)}
              className="cursor-pointer rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
            >
              Select This Folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
