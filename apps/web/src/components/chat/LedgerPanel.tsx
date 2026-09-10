import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { LedgerEntry } from "@deepagents-ide/shared";
import { LEDGER_STATUS_ORDER as STATUS_ORDER, ledgerStatusMeta as meta } from "../../lib/ledgerStatus";

export function LedgerPanel({ entries }: Props) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;

  const counts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});

  // Anything needing attention first — a long run's failures should not be buried under
  // hundreds of successful conversions.
  const sorted = [...entries].sort(
    (a, b) => STATUS_ORDER.indexOf(a.status as never) - STATUS_ORDER.indexOf(b.status as never)
  );

  return (
    <div className="flex-none border-b border-neutral-800 px-3 py-2.5">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 text-left"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 flex-none text-neutral-500" />
        ) : (
          <ChevronRight className="h-3 w-3 flex-none text-neutral-500" />
        )}
        <span className="text-[11px] uppercase tracking-wide text-neutral-500">
          Migrated files ({entries.length})
        </span>
        <span className="ml-auto flex items-center gap-2">
          {STATUS_ORDER.filter((s) => counts[s]).map((s) => {
            const { icon: Icon, className } = meta(s);
            return (
              <span key={s} className={`flex items-center gap-1 text-[11px] ${className}`}>
                <Icon className="h-3 w-3" />
                {counts[s]}
              </span>
            );
          })}
        </span>
      </button>

      {open && (
        <div className="mt-1.5 max-h-56 overflow-y-auto">
          {sorted.map((entry, i) => {
            const { icon: Icon, className } = meta(entry.status);
            return (
              <div key={`${entry.path}-${i}`} className="flex items-start gap-1.5 py-0.5 text-xs">
                <Icon className={`mt-0.5 h-3 w-3 flex-none ${className}`} />
                <div className="min-w-0">
                  <div className="break-all text-neutral-300">
                    {entry.path}
                    {entry.target ? <span className="text-neutral-500"> → {entry.target}</span> : null}
                  </div>
                  {entry.note ? <div className="break-words text-[11px] text-neutral-500">{entry.note}</div> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
