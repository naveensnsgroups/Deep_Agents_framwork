import { useEffect, useState } from "react";
import type { AgentInfo } from "@deepagents-ide/shared";
import { SERVER_URL } from "../../lib/ws-client";
import { apiFetch } from "../../lib/auth";

interface Props {
  onClose: () => void;
}

export function SystemInfoPanel({ onClose }: Props) {
  const [info, setInfo] = useState<AgentInfo | null>(null);

  useEffect(() => {
    apiFetch(`${SERVER_URL}/api/agent-info`)
      .then((res) => res.json())
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="max-h-[80vh] w-[min(640px,90vw)] overflow-y-auto rounded-xl border border-neutral-700 bg-neutral-900 px-5 py-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold text-neutral-100">Agent Configuration</h2>
          <button className="cursor-pointer border-none bg-transparent text-xl leading-none text-neutral-400 hover:text-white" onClick={onClose}>
            ×
          </button>
        </div>
        {!info ? (
          <div className="text-neutral-400">Loading…</div>
        ) : (
          <>
            <h3 className="mb-1.5 mt-4 text-xs uppercase tracking-wide text-neutral-500">System Prompt</h3>
            <pre className="whitespace-pre-wrap rounded-md border border-neutral-800 bg-neutral-950 p-2.5 text-xs text-neutral-200">
              {info.systemPrompt}
            </pre>
            <h3 className="mb-1.5 mt-4 text-xs uppercase tracking-wide text-neutral-500">Skills</h3>
            <div className="flex flex-col">
              {info.skills?.length ? (
                info.skills.map((s) => (
                  <div key={s.name} className="border-b border-neutral-800 py-1.5 text-xs">
                    <span className="font-mono text-emerald-300">{s.name}</span>
                    <div className="mt-0.5 text-neutral-400">{s.description}</div>
                  </div>
                ))
              ) : (
                <div className="text-xs text-neutral-500">No playbooks mounted.</div>
              )}
            </div>

            <h3 className="mb-1.5 mt-4 text-xs uppercase tracking-wide text-neutral-500">Subagents</h3>
            <div className="flex flex-col">
              {info.subagents?.map((s) => (
                <div key={s.name} className="border-b border-neutral-800 py-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-amber-300">{s.name}</span>
                    {s.readOnly && (
                      <span className="rounded border border-neutral-700 px-1 text-[10px] text-neutral-400">read-only</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-neutral-400">{s.description}</div>
                </div>
              ))}
            </div>

            <h3 className="mb-1.5 mt-4 text-xs uppercase tracking-wide text-neutral-500">Tools</h3>
            <div className="flex flex-col">
              {info.tools.map((t) => (
                <div key={t.name} className="flex gap-2.5 border-b border-neutral-800 py-1 text-xs">
                  <span className="w-[90px] flex-none font-mono text-blue-300">{t.name}</span>
                  <span className="text-neutral-300">{t.description}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
