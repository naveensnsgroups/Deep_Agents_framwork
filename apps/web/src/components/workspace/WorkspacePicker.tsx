import { useEffect, useState, type ClipboardEvent } from "react";
import type { ModelId, ProviderOption, WorkspaceOptions } from "@deepagents-ide/shared";
import { SERVER_URL } from "../../lib/ws-client";
import { apiFetch } from "../../lib/auth";
import { FolderBrowserModal } from "./FolderBrowserModal";
import { UserMenu } from "../auth/UserMenu";
import { ThemeToggle } from "../layout/ThemeToggle";
import { useSession } from "../../lib/session";

interface Props {
  onOpen: (projectRoot: string, model: ModelId, options: WorkspaceOptions) => void;
}

function splitPaths(value: string): string[] {
  return value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Turns a real absolute path (typed, pasted, or picked from the folder browser) into the
 * workspace-relative glob our backend's auto-approve/protected-path matching expects.
 * A value that already looks relative (or doesn't fall under the project root) is left as
 * typed, so a deliberately-written glob never gets mangled.
 */
function toRelativeGlob(input: string, projectRoot: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\");
  if (!isAbsolute) return trimmed;

  const normInput = normalizePath(trimmed);
  const normRoot = normalizePath(projectRoot);
  if (!normRoot) return trimmed;

  if (normInput.toLowerCase() === normRoot.toLowerCase()) return "/**";
  if (normInput.toLowerCase().startsWith(normRoot.toLowerCase() + "/")) {
    return `${normInput.slice(normRoot.length)}/**`;
  }
  return trimmed;
}

function normalizeGlobList(value: string, projectRoot: string): string {
  return splitPaths(value)
    .map((segment) => toRelativeGlob(segment, projectRoot))
    .join(", ");
}

const fieldClass =
  "rounded-md border border-neutral-700 light:border-neutral-300 bg-neutral-900 light:bg-neutral-50 px-3 py-2 text-sm text-neutral-100 light:text-neutral-900 outline-none focus:border-blue-500";
const labelClass = "text-[11px] uppercase tracking-wide text-neutral-500";

type BrowseTarget = "project" | "autoApprove" | "readOnly" | null;

/**
 * Everything here except the project path/provider/model/glob settings — never the API
 * key or GitHub token. Those stay exactly as documented everywhere else in this app:
 * server-memory only, re-entered each session, never written to disk (and localStorage
 * is disk as far as that promise is concerned).
 */
const STORAGE_KEY = "deepagents:lastWorkspace";

interface SavedSetup {
  projectRoot?: string;
  providerId?: string;
  modelName?: string;
  autoApprove?: string;
  readOnly?: string;
}

function loadSaved(): SavedSetup {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedSetup) : {};
  } catch {
    return {};
  }
}

/** A token pasted into a repo URL; the server refuses these, and they must not be saved here either. */
function hasEmbeddedCredentials(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.username !== "" || url.password !== "";
  } catch {
    return false;
  }
}

function saveSetup(setup: SavedSetup) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(setup));
  } catch {
    // private browsing / storage disabled — losing the convenience pre-fill isn't fatal
  }
}

export function WorkspacePicker({ onOpen }: Props) {
  const { authMode } = useSession();
  const signedIn = authMode === "oauth";
  const [projectRoot, setProjectRoot] = useState(() => loadSaved().projectRoot ?? "");
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [providerId, setProviderId] = useState("");
  const [modelName, setModelName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [autoApprove, setAutoApprove] = useState(() => loadSaved().autoApprove ?? "");
  const [readOnly, setReadOnly] = useState(() => loadSaved().readOnly ?? "");
  const [githubToken, setGithubToken] = useState("");
  const [browseTarget, setBrowseTarget] = useState<BrowseTarget>(null);

  // Re-run after "My keys" changes, so a key saved there immediately counts as available here.
  const [keysVersion, setKeysVersion] = useState(0);

  useEffect(() => {
    apiFetch(`${SERVER_URL}/api/providers`)
      .then((res) => res.json())
      .then((data: { providers: ProviderOption[] }) => {
        setProviders(data.providers);
        // Only choose a provider on first load; a refresh after saving a key keeps the selection.
        if (keysVersion > 0) return;
        const saved = loadSaved();
        const restored = saved.providerId ? data.providers.find((p) => p.id === saved.providerId) : undefined;
        const preferred = restored ?? data.providers.find((p) => p.serverKey || p.userKey) ?? data.providers[0];
        if (preferred) {
          setProviderId(preferred.id);
          setModelName((restored && saved.modelName) || preferred.defaultModel);
        }
      })
      .catch(() => setProviders([]));
  }, [keysVersion]);

  const provider = providers.find((p) => p.id === providerId);
  const hasStoredKey = provider != null && (provider.serverKey || provider.userKey === true);
  const needsKey = provider != null && !hasStoredKey && !apiKey.trim();
  const canOpen = projectRoot.trim() !== "" && modelName.trim() !== "" && providerId !== "" && !needsKey;

  function handleProviderChange(id: string) {
    setProviderId(id);
    const next = providers.find((p) => p.id === id);
    if (next) setModelName(next.defaultModel);
  }

  function appendGlob(current: string, setValue: (v: string) => void, picked: string) {
    const converted = toRelativeGlob(picked, projectRoot);
    setValue(current.trim() ? `${current.trim()}, ${converted}` : converted);
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>, current: string, setValue: (v: string) => void) {
    const pasted = e.clipboardData.getData("text");
    if (!pasted || !/^[a-zA-Z]:[\\/]/.test(pasted.trim())) return; // let plain glob text paste through normally
    e.preventDefault();
    appendGlob(current, setValue, pasted);
  }

  function handleFolderPicked(path: string) {
    if (browseTarget === "project") setProjectRoot(path);
    else if (browseTarget === "autoApprove") appendGlob(autoApprove, setAutoApprove, path);
    else if (browseTarget === "readOnly") appendGlob(readOnly, setReadOnly, path);
    setBrowseTarget(null);
  }

  function open() {
    const options: WorkspaceOptions = {};
    if (apiKey.trim()) options.apiKey = apiKey.trim();
    if (autoApprove.trim())
      options.autoApprovePaths = splitPaths(autoApprove).map((p) => toRelativeGlob(p, projectRoot));
    if (readOnly.trim())
      options.readOnlyPaths = splitPaths(readOnly).map((p) => toRelativeGlob(p, projectRoot));
    if (githubToken.trim()) options.githubToken = githubToken.trim();
    saveSetup({
      projectRoot: hasEmbeddedCredentials(projectRoot) ? undefined : projectRoot.trim(),
      providerId,
      modelName: modelName.trim(),
      autoApprove: autoApprove.trim(),
      readOnly: readOnly.trim(),
    });
    onOpen(projectRoot.trim(), `${providerId}:${modelName.trim()}`, options);
  }

  return (
    <div className="flex h-screen items-center justify-center overflow-y-auto px-5 py-6">
      <div className="flex w-full max-w-[520px] flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="" className="h-10 w-auto flex-none object-contain" />
          <h1 className="text-2xl font-bold text-neutral-100 light:text-neutral-900">Code Migration Agents</h1>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <UserMenu onKeysChanged={() => setKeysVersion((v) => v + 1)} />
        </div>
      </div>

      <label className={labelClass}>{signedIn ? "GitHub repo" : "Project folder or GitHub repo"}</label>
      <div className="flex gap-2">
        <input
          type="text"
          placeholder={signedIn ? "https://github.com/user/repo" : "E:\\path\\to\\your\\project  or  https://github.com/user/repo"}
          value={projectRoot}
          onChange={(e) => setProjectRoot(e.target.value)}
          className={`${fieldClass} flex-1`}
        />
        {!signedIn && (
          <button
            type="button"
            onClick={() => setBrowseTarget("project")}
            className="cursor-pointer rounded-md border border-neutral-700 light:border-neutral-300 bg-neutral-800 light:bg-neutral-100 px-3 text-xs text-neutral-200 light:text-neutral-800 hover:bg-neutral-700 light:hover:bg-neutral-200"
          >
            Browse…
          </button>
        )}
      </div>
      <p className="-mt-1 text-[11px] text-neutral-500">
        {signedIn
          ? <>This server can't see your computer's disk — paste a GitHub URL and it's cloned server-side (append <code>#branch-name</code> for a specific branch).</>
          : <>A GitHub URL is cloned server-side (append <code>#branch-name</code> for a specific branch) — for when the
            backend can't see your local disk, e.g. a cloud deployment.</>}
      </p>

      <label className={labelClass}>Provider</label>
      <select value={providerId} onChange={(e) => handleProviderChange(e.target.value)} className={fieldClass}>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>

      <label className={labelClass}>Model</label>
      <input
        type="text"
        placeholder="model name"
        value={modelName}
        onChange={(e) => setModelName(e.target.value)}
        className={`${fieldClass} font-mono`}
      />

      <label className={labelClass}>
        API key{" "}
        {provider?.serverKey
          ? "(optional — server key will be used)"
          : provider?.userKey
            ? "(optional — your saved key will be used)"
            : signedIn
              ? "(required — or save it in My keys)"
              : "(required)"}
      </label>
      <input
        type="password"
        placeholder={provider?.keyPlaceholder ?? "your API key"}
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        className={`${fieldClass} font-mono`}
        autoComplete="off"
      />
      <p className="-mt-1 text-[11px] text-neutral-500">
        Kept in server memory for this session only — never written to disk.
      </p>

      <button
        type="button"
        onClick={() => setShowAdvanced((s) => !s)}
        className="self-start text-xs text-blue-400 light:text-blue-600 hover:text-blue-300 light:hover:text-blue-800"
      >
        {showAdvanced ? "▾" : "▸"} Migration settings
      </button>

      {showAdvanced && (
        <div className="flex flex-col gap-3 rounded-md border border-neutral-800 light:border-neutral-200 bg-neutral-900/50 light:bg-neutral-50 p-3">
          <label className={labelClass}>Output folder — auto-approve writes to (comma-separated)</label>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="/migrated/**, /out/**"
              value={autoApprove}
              onChange={(e) => setAutoApprove(e.target.value)}
              onPaste={(e) => handlePaste(e, autoApprove, setAutoApprove)}
              onBlur={() => setAutoApprove((v) => normalizeGlobList(v, projectRoot))}
              className={`${fieldClass} flex-1 font-mono`}
            />
            <button
              type="button"
              onClick={() => setBrowseTarget("autoApprove")}
              className="cursor-pointer rounded-md border border-neutral-700 light:border-neutral-300 bg-neutral-800 light:bg-neutral-100 px-3 text-xs text-neutral-200 light:text-neutral-800 hover:bg-neutral-700 light:hover:bg-neutral-200"
            >
              Browse…
            </button>
          </div>
          <p className="-mt-1 text-[11px] text-neutral-500">
            Writes inside these paths skip the approval prompt. Paste or browse a real folder under
            your project and it converts to the right pattern automatically. Everything else still
            stops for review.
          </p>

          <label className={labelClass}>Legacy source — always ask before writing to (comma-separated)</label>
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="/legacy/**, /src/**"
              value={readOnly}
              onChange={(e) => setReadOnly(e.target.value)}
              onPaste={(e) => handlePaste(e, readOnly, setReadOnly)}
              onBlur={() => setReadOnly((v) => normalizeGlobList(v, projectRoot))}
              className={`${fieldClass} flex-1 font-mono`}
            />
            <button
              type="button"
              onClick={() => setBrowseTarget("readOnly")}
              className="cursor-pointer rounded-md border border-neutral-700 light:border-neutral-300 bg-neutral-800 light:bg-neutral-100 px-3 text-xs text-neutral-200 light:text-neutral-800 hover:bg-neutral-700 light:hover:bg-neutral-200"
            >
              Browse…
            </button>
          </div>
          <p className="-mt-1 text-[11px] text-neutral-500">
            Writes here can never be auto-approved, even if an auto-approve glob covers them. Shell
            commands always require approval regardless.
          </p>

          {/* Signed-in users manage this token once in "My keys" instead — it already covers
              clone/push and the agent's GitHub tools, so a second entry point here would just be
              a confusing duplicate of the same setting. */}
          {!signedIn && (
            <>
              <label className={labelClass}>GitHub Personal Access Token (optional)</label>
              <input
                type="password"
                placeholder="ghp_… or github_pat_…"
                value={githubToken}
                onChange={(e) => setGithubToken(e.target.value)}
                className={`${fieldClass} font-mono`}
                autoComplete="off"
              />
              <p className="-mt-1 text-[11px] text-neutral-500">
                Connects GitHub's official MCP server so the agent can read/search repos, issues, and
                PRs directly. Kept in server memory for this session only — never written to disk. Needs
                a token with the scopes for whatever you want it to access.
              </p>
            </>
          )}
        </div>
      )}

      <button
        disabled={!canOpen}
        onClick={open}
        className="mt-1 cursor-pointer rounded-md bg-blue-600 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-neutral-700 light:disabled:bg-neutral-200 disabled:text-neutral-400 light:disabled:text-neutral-600"
      >
        Open Workspace
      </button>

      {browseTarget && (
        <FolderBrowserModal
          title={browseTarget === "project" ? "Select project folder" : browseTarget === "autoApprove" ? "Select output folder" : "Select protected folder"}
          initialPath={browseTarget !== "project" && projectRoot ? projectRoot : undefined}
          onSelect={handleFolderPicked}
          onClose={() => setBrowseTarget(null)}
        />
      )}
      </div>
    </div>
  );
}
