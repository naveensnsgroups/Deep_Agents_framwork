import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, FileSearch } from "lucide-react";
import type { ReadProvenance } from "@deepagents-ide/shared";

/**
 * Shows what the agent read just before proposing the action on this approval card.
 *
 * Approving a command without knowing what prompted it is the weak point of the whole review
 * step: a command the agent reasoned its way to and one a file told it to run look exactly
 * the same at the moment you have to decide. The agent reads repositories nobody here wrote,
 * so that difference is the thing worth surfacing.
 *
 * Collapsed by default, because on the overwhelming majority of cards this is unremarkable —
 * unless a file contained text aimed at an agent, in which case it opens itself and says so.
 */
export function ProvenancePanel({ provenance }: { provenance: ReadProvenance[] }) {
  const flagged = provenance.filter((p) => p.signals.length > 0);
  const [open, setOpen] = useState(flagged.length > 0);

  if (provenance.length === 0) return null;

  return (
    <div className="mt-2 border-t border-neutral-800 light:border-neutral-200 pt-2">
      {flagged.length > 0 ? (
        <div className="mb-2 flex items-start gap-1.5 rounded border border-amber-700/50 light:border-amber-300/50 bg-amber-950/40 light:bg-amber-50 px-2 py-1.5">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none text-amber-400 light:text-amber-600" />
          <div className="min-w-0 text-[11px] leading-relaxed text-amber-200 light:text-amber-800">
            {flagged.length === 1 ? "A file the agent just read contains" : `${flagged.length} files the agent just read contain`}{" "}
            text written to instruct an AI agent. Treat this request with extra care — check that it
            is something <em>you</em> asked for.
          </div>
        </div>
      ) : null}

      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 text-left text-[11px] text-neutral-500 hover:text-neutral-300 light:hover:text-neutral-700"
      >
        {open ? <ChevronDown className="h-3 w-3 flex-none" /> : <ChevronRight className="h-3 w-3 flex-none" />}
        <FileSearch className="h-3 w-3 flex-none" />
        Read before this ({provenance.length})
      </button>

      {open ? (
        <div className="mt-1.5 flex flex-col gap-1.5 pl-4">
          {provenance.map((entry, i) => (
            <div key={`${entry.target}-${i}`} className="min-w-0 text-[11px]">
              <div className="flex items-baseline gap-1.5">
                <span className="font-mono text-neutral-500">{entry.tool}</span>
                <span className="break-all text-neutral-300 light:text-neutral-700">{entry.target}</span>
              </div>

              {entry.signals.map((signal, j) => (
                <div key={j} className="mt-1 border-l-2 border-amber-700/60 light:border-amber-300/60 pl-2">
                  <div className="text-[10px] uppercase tracking-wide text-amber-500 light:text-amber-600">{signal.label}</div>
                  {/* The matched line verbatim. Rendered as plain text, never markdown — the
                      whole point is showing exactly what the file said. */}
                  <div className="mt-0.5 break-words font-mono text-[10px] leading-relaxed text-amber-200/90 light:text-amber-800/90">
                    {signal.excerpt}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
