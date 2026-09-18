import { useEffect, useState } from "react";
import { Check, Github, Loader2, Trash2 } from "lucide-react";
import type { KeysResponse, KeyStatus } from "@deepagents-ide/shared";
import { deleteKey, fetchKeys, saveKey } from "../../lib/auth";

interface Props {
  onClose: () => void;
  /** Called after any save or removal, so the picker can refresh which providers have a key. */
  onChanged?: () => void;
}

const HINTS: Record<string, string> = {
  anthropic: "sk-ant-…",
  "google-genai": "AIza…",
  openai: "sk-…",
  openrouter: "sk-or-…",
  github: "ghp_… or github_pat_…",
};

/**
 * Where a signed-in user manages their own keys. Values are write-only from here: the server
 * stores them encrypted and only ever reports back whether each one is saved.
 */
export function KeysPanel({ onClose, onChanged }: Props) {
  const [data, setData] = useState<KeysResponse | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    fetchKeys()
      .then(setData)
      .catch((err: Error) => setLoadError(err.message));
  }, []);

  function update(next: KeysResponse) {
    setData(next);
    onChanged?.();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div
        className="max-h-[85vh] w-[min(560px,100%)] overflow-y-auto rounded-xl border border-neutral-700 light:border-neutral-300 bg-neutral-900 light:bg-neutral-50 px-5 py-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-base font-semibold text-neutral-100 light:text-neutral-900">My keys</h2>
          <button className="cursor-pointer text-xl leading-none text-neutral-400 light:text-neutral-600 hover:text-white light:hover:text-neutral-900" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="mb-4 text-xs text-neutral-500">
          Stored encrypted on the server and used only for your own workspaces. Saved values are never shown again — to
          change one, save a new value over it.
        </p>

        {loadError ? <p className="text-xs text-red-400 light:text-red-600">{loadError}</p> : null}
        {!data && !loadError ? <Loader2 className="h-4 w-4 animate-spin text-neutral-500" /> : null}

        {data && (
          <div className="flex flex-col gap-3">
            {data.keys.map((key) => (
              <KeyRow key={key.name} status={key} onUpdate={update} />
            ))}
            <div className="flex items-start gap-2 rounded-md border border-neutral-800 light:border-neutral-200 bg-neutral-950/50 light:bg-white/60 p-2.5 text-[11px] text-neutral-400 light:text-neutral-600">
              <Github className="mt-0.5 h-3.5 w-3.5 flex-none" />
              {data.githubLinked
                ? "Your GitHub login is used to clone private repositories and push. A personal access token above is only needed for the agent's GitHub tools (issues, PRs, search), or to use different permissions."
                : "Your GitHub login has no repository access saved. Sign out and in again, or save a personal access token above."}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function KeyRow({ status, onUpdate }: { status: KeyStatus; onUpdate: (next: KeysResponse) => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(action: () => Promise<KeysResponse>) {
    setBusy(true);
    setError("");
    try {
      onUpdate(await action());
      setValue("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 border-b border-neutral-800 light:border-neutral-200 pb-3 last:border-b-0">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-200 light:text-neutral-800">{status.label}</span>
        {status.saved ? (
          <span className="flex items-center gap-1 text-[11px] text-green-400 light:text-green-600">
            <Check className="h-3 w-3" />
            Saved{status.updatedAt ? ` ${new Date(status.updatedAt).toLocaleDateString()}` : ""}
          </span>
        ) : (
          <span className="text-[11px] text-neutral-600">Not saved</span>
        )}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) void run(() => saveKey(status.name, value.trim()));
        }}
      >
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={status.saved ? "Enter a new value to replace it" : HINTS[status.name] ?? "Key"}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-neutral-700 light:border-neutral-300 bg-neutral-950 light:bg-white px-2.5 py-1.5 font-mono text-xs text-neutral-100 light:text-neutral-900 outline-none focus:border-blue-500"
        />
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className="cursor-pointer rounded-md bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-neutral-700 light:disabled:bg-neutral-200 disabled:text-neutral-400 light:disabled:text-neutral-600"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
        </button>
        {status.saved && (
          <button
            type="button"
            disabled={busy}
            title="Remove this key"
            onClick={() => {
              if (window.confirm(`Remove your saved ${status.label} key?`)) void run(() => deleteKey(status.name));
            }}
            className="cursor-pointer rounded-md border border-neutral-700 light:border-neutral-300 bg-neutral-800 light:bg-neutral-100 px-2 text-neutral-400 light:text-neutral-600 hover:text-red-300 light:hover:text-red-700 disabled:cursor-not-allowed"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </form>
      {error ? <p className="text-[11px] text-red-400 light:text-red-600">{error}</p> : null}
    </div>
  );
}
