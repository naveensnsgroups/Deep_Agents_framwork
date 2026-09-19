import { useEffect, useState } from "react";
import type { AgentInfo } from "@deepagents-ide/shared";
import { SERVER_URL } from "../../lib/ws-client";
import { apiFetch } from "../../lib/auth";

interface Props {
  onClose: () => void;
}

/** Settings: for now, how the agent is configured — its prompt, playbooks, subagents and tools. */
export function SettingsPanel({ onClose }: Props) {
  const [info, setInfo] = useState<AgentInfo | null>(null);

  useEffect(() => {
    apiFetch(`${SERVER_URL}/api/agent-info`)
      .then((res) => res.json())
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="max-h-[80vh] w-[min(640px,90vw)] overflow-y-auto rounded-xl border border-neutral-700 light:border-neutral-300 bg-neutral-900 light:bg-neutral-50 px-5 py-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 id="settings-title" className="text-base font-semibold text-neutral-100 light:text-neutral-900">
            Settings
          </h2>
          <button
            aria-label="Close settings"
            className="cursor-pointer border-none bg-transparent text-xl leading-none text-neutral-400 light:text-neutral-600 hover:text-white light:hover:text-neutral-900"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <h3 className="text-sm font-semibold text-neutral-200 light:text-neutral-800">Agent</h3>
        <p className="mt-0.5 text-xs text-neutral-500">What the agent is told, and what it can use.</p>
        {!info ? (
          <div className="text-neutral-400 light:text-neutral-600">Loading…</div>
        ) : (
          <>
            <h3 className="mb-1.5 mt-4 text-xs uppercase tracking-wide text-neutral-500">System Prompt</h3>
            <pre className="whitespace-pre-wrap rounded-md border border-neutral-800 light:border-neutral-200 bg-neutral-950 light:bg-white p-2.5 text-xs text-neutral-200 light:text-neutral-800">
              {info.systemPrompt}
            </pre>
            <h3 className="mb-1.5 mt-4 text-xs uppercase tracking-wide text-neutral-500">Skills</h3>
            <div className="flex flex-col">
              {info.skills?.length ? (
                info.skills.map((s) => (
                  <div key={s.name} className="border-b border-neutral-800 light:border-neutral-200 py-1.5 text-xs">
                    <span className="font-mono text-emerald-300 light:text-emerald-700">{s.name}</span>
                    <div className="mt-0.5 text-neutral-400 light:text-neutral-600">{s.description}</div>
                  </div>
                ))
              ) : (
                <div className="text-xs text-neutral-500">No playbooks mounted.</div>
              )}
            </div>

            <h3 className="mb-1.5 mt-4 text-xs uppercase tracking-wide text-neutral-500">Subagents</h3>
            <div className="flex flex-col">
              {info.subagents?.map((s) => (
                <div key={s.name} className="border-b border-neutral-800 light:border-neutral-200 py-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-amber-300 light:text-amber-700">{s.name}</span>
                    {s.readOnly && (
                      <span className="rounded border border-neutral-700 light:border-neutral-300 px-1 text-[10px] text-neutral-400 light:text-neutral-600">read-only</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-neutral-400 light:text-neutral-600">{s.description}</div>
                </div>
              ))}
            </div>

            <h3 className="mb-1.5 mt-4 text-xs uppercase tracking-wide text-neutral-500">Tools</h3>
            <div className="flex flex-col">
              {info.tools.map((t) => (
                <div key={t.name} className="flex gap-2.5 border-b border-neutral-800 light:border-neutral-200 py-1 text-xs">
                  <span className="w-[90px] flex-none font-mono text-blue-300 light:text-blue-800">{t.name}</span>
                  <span className="text-neutral-300 light:text-neutral-700">{t.description}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
