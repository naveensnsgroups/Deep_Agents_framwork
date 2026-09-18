import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ChevronsDownUp, Loader2, RefreshCw, Search, X } from "lucide-react";
import type { FileNode, LedgerEntry } from "@deepagents-ide/shared";
import { iconUrlFor, folderIconUrlFor, DEFAULT_ICON_URL, DEFAULT_FOLDER_ICON_URL } from "../../lib/fileTypes";
import { ledgerStatusMeta } from "../../lib/ledgerStatus";

interface Props {
  nodes: FileNode[];
  selected: string | null;
  onSelect: (path: string) => void;
  ledger?: LedgerEntry[];
  onRefresh?: () => void;
  loading?: boolean;
}

function FileIcon({ name }: { name: string }) {
  return (
    <img
      className="h-[15px] w-[15px] flex-none"
      src={iconUrlFor(name)}
      onError={(e) => (e.currentTarget.src = DEFAULT_ICON_URL)}
      alt=""
    />
  );
}

function FolderIcon({ name, open }: { name: string; open: boolean }) {
  return (
    <img
      className="h-[15px] w-[15px] flex-none"
      src={folderIconUrlFor(name, open)}
      onError={(e) => (e.currentTarget.src = DEFAULT_FOLDER_ICON_URL)}
      alt=""
    />
  );
}

/** The agent's own filesystem addresses files with a leading "/" (`/routes.js`); the real
 * on-disk tree from the server never has one (`path.relative` doesn't produce one). Both
 * sides need to agree before a ledger entry can be matched up with a tree node. */
function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function buildStatusMap(ledger: LedgerEntry[]): Map<string, LedgerEntry> {
  const map = new Map<string, LedgerEntry>();
  for (const entry of ledger) {
    if (entry.path) map.set(normalizePath(entry.path), entry);
    if (entry.target) map.set(normalizePath(entry.target), entry);
  }
  return map;
}

function matchesQuery(node: FileNode, query: string): boolean {
  if (!query) return true;
  if (node.name.toLowerCase().includes(query)) return true;
  if (node.type === "dir") return (node.children ?? []).some((c) => matchesQuery(c, query));
  return false;
}

interface TreeProps {
  nodes: FileNode[];
  selected: string | null;
  onSelect: (path: string) => void;
  expandedPaths: Set<string>;
  toggleExpand: (path: string) => void;
  statusMap: Map<string, LedgerEntry>;
  query: string;
}

function Tree({ nodes, selected, onSelect, expandedPaths, toggleExpand, statusMap, query }: TreeProps) {
  const visible = query ? nodes.filter((n) => matchesQuery(n, query)) : nodes;

  return (
    <>
      {visible.map((node) => {
        if (node.type === "dir") {
          // While filtering, every visible directory contains a match by construction
          // (matchesQuery already checked), so force it open rather than requiring the
          // user to also have it manually expanded — a search result hidden inside a
          // collapsed folder would defeat the point of searching.
          const isOpen = query ? true : expandedPaths.has(node.path);
          return (
            <div key={node.path}>
              <button
                type="button"
                onClick={() => toggleExpand(node.path)}
                className="flex w-full cursor-pointer items-center gap-1 rounded px-1.5 py-1 text-left hover:bg-neutral-800 light:hover:bg-neutral-100"
              >
                {isOpen ? (
                  <ChevronDown className="h-3 w-3 flex-none text-neutral-500" />
                ) : (
                  <ChevronRight className="h-3 w-3 flex-none text-neutral-500" />
                )}
                <FolderIcon name={node.name} open={isOpen} />
                <span className="truncate">{node.name}</span>
              </button>
              {isOpen && (
                <div className="ml-[7px] border-l border-neutral-800/70 light:border-neutral-200/70 pl-[9px]">
                  <Tree
                    nodes={node.children ?? []}
                    selected={selected}
                    onSelect={onSelect}
                    expandedPaths={expandedPaths}
                    toggleExpand={toggleExpand}
                    statusMap={statusMap}
                    query={query}
                  />
                </div>
              )}
            </div>
          );
        }

        const status = statusMap.get(node.path);
        const statusMeta = status ? ledgerStatusMeta(status.status) : null;
        return (
          <div
            key={node.path}
            onClick={() => onSelect(node.path)}
            className={`flex cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 hover:bg-neutral-800 light:hover:bg-neutral-100 ${
              selected === node.path ? "bg-blue-900/60 light:bg-blue-100" : ""
            }`}
          >
            <FileIcon name={node.name} />
            <span className="flex-1 truncate">{node.name}</span>
            {statusMeta && (
              <span title={`Migration: ${statusMeta.label}`} className="flex-none">
                <statusMeta.icon className={`h-3 w-3 ${statusMeta.className}`} />
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

export function FileTree({ nodes, selected, onSelect, ledger = [], onRefresh, loading }: Props) {
  const [query, setQuery] = useState("");
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const initialized = useRef(false);

  // Auto-expand the first two levels once, the first time a real tree arrives — a project
  // you just opened should show more than three collapsed top-level rows, but this should
  // never fight the user's own manual expand/collapse choices on later reloads (the tree
  // reloads after every tool call).
  useEffect(() => {
    if (initialized.current || nodes.length === 0) return;
    initialized.current = true;
    const next = new Set<string>();
    const walk = (list: FileNode[], depth: number) => {
      for (const n of list) {
        if (n.type !== "dir") continue;
        if (depth < 2) next.add(n.path);
        walk(n.children ?? [], depth + 1);
      }
    };
    walk(nodes, 0);
    setExpandedPaths(next);
  }, [nodes]);

  const statusMap = useMemo(() => buildStatusMap(ledger), [ledger]);

  function toggleExpand(path: string) {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-[13px]">
      <div className="sticky top-0 z-10 flex flex-none items-center gap-1 border-b border-neutral-800 light:border-neutral-200 bg-neutral-900 light:bg-neutral-50 px-2 py-1.5">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-neutral-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value.toLowerCase())}
            placeholder="Filter files…"
            className="w-full rounded border border-neutral-700 light:border-neutral-300 bg-neutral-950 light:bg-white py-1 pl-6 pr-2 text-xs text-neutral-200 light:text-neutral-800 outline-none focus:border-blue-500"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              title="Clear filter"
              className="absolute right-1 top-1/2 -translate-y-1/2 cursor-pointer text-neutral-500 hover:text-neutral-200 light:hover:text-neutral-800"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setExpandedPaths(new Set())}
          title="Collapse all"
          className="flex-none cursor-pointer rounded p-1 text-neutral-400 light:text-neutral-600 hover:bg-neutral-800 light:hover:bg-neutral-100 hover:text-neutral-200 light:hover:text-neutral-800"
        >
          <ChevronsDownUp className="h-3.5 w-3.5" />
        </button>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            title="Refresh"
            className="flex-none cursor-pointer rounded p-1 text-neutral-400 light:text-neutral-600 hover:bg-neutral-800 light:hover:bg-neutral-100 hover:text-neutral-200 light:hover:text-neutral-800"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {/* Only shows for the very first load — a background refresh after a tool call
            (or the manual refresh button) updates the list in place instead of blanking
            an already-visible tree behind a spinner. */}
        {loading && nodes.length === 0 ? (
          <div className="flex items-center gap-1.5 px-1.5 py-2 text-xs text-neutral-500">
            <Loader2 className="h-3.5 w-3.5 flex-none animate-spin" />
            Loading files…
          </div>
        ) : nodes.length === 0 ? (
          <div className="px-1.5 py-2 text-xs text-neutral-500">No files in this project yet.</div>
        ) : query && !nodes.some((n) => matchesQuery(n, query)) ? (
          <div className="px-1.5 py-2 text-xs text-neutral-500">No files match "{query}".</div>
        ) : (
          <Tree
            nodes={nodes}
            selected={selected}
            onSelect={onSelect}
            expandedPaths={expandedPaths}
            toggleExpand={toggleExpand}
            statusMap={statusMap}
            query={query}
          />
        )}
      </div>
    </div>
  );
}
