import { useState } from "react";
import { Bot, Check, ChevronDown, ChevronRight, Hourglass, Loader2, Square, X } from "lucide-react";
import { ToolIcon } from "../../lib/toolIcons";
import type { TimelineItem } from "../../types";

type Props = Omit<Extract<TimelineItem, { kind: "subagent" }>, "kind" | "id">;

const STATUS = {
  running: { label: "Working", icon: Loader2, className: "text-sky-400 light:text-sky-700", spin: true },
  waiting: { label: "Waiting for you", icon: Hourglass, className: "text-amber-400 light:text-amber-700", spin: false },
  done: { label: "Done", icon: Check, className: "text-green-500 light:text-green-700", spin: false },
  failed: { label: "Failed", icon: X, className: "text-red-400 light:text-red-600", spin: false },
  stopped: { label: "Stopped", icon: Square, className: "text-neutral-500", spin: false },
} as const;

/**
 * One delegated task, live: which subagent, what it was asked, and the tools it is calling as it
 * works. Its answer arrives afterwards as the `task` tool's result, like any other tool's.
 */
export function SubagentCard({ subagent, description, status, activity, steps }: Props) {
  const [expanded, setExpanded] = useState(false);
  const meta = STATUS[status];
  const Icon = meta.icon;
  const latest = activity.at(-1);
  const hidden = steps - activity.length;

  return (
    <div className="overflow-hidden rounded-md border border-neutral-800 light:border-neutral-200">
      <button
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer items-start gap-2 border-none bg-neutral-900 light:bg-neutral-50 px-2.5 py-1.5 text-left text-xs hover:bg-neutral-800 light:hover:bg-neutral-100"
      >
        <Bot className="mt-px h-3.5 w-3.5 flex-none text-neutral-400 light:text-neutral-600" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-neutral-200 light:text-neutral-800">{subagent}</span>
            <span className={`flex items-center gap-1 text-[11px] ${meta.className}`}>
              <Icon className={`h-3 w-3 ${meta.spin ? "animate-spin" : ""}`} />
              {meta.label}
            </span>
            {steps > 0 && <span className="ml-auto flex-none text-[11px] text-neutral-500">{steps} {steps === 1 ? "step" : "steps"}</span>}
          </div>
          <div className={`text-neutral-400 light:text-neutral-600 ${expanded ? "whitespace-pre-wrap break-words" : "truncate"}`}>{description}</div>
          {!expanded && status === "running" && latest && (
            <div className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-neutral-500">
              <ToolIcon name={latest.tool} className="h-3 w-3 flex-none" />
              <span className="flex-none">{latest.tool}</span>
              {latest.target && <span className="truncate">{latest.target}</span>}
            </div>
          )}
        </div>
        {expanded ? <ChevronDown className="mt-px h-3.5 w-3.5 flex-none text-neutral-600" /> : <ChevronRight className="mt-px h-3.5 w-3.5 flex-none text-neutral-600" />}
      </button>

      {expanded && (
        <div className="max-h-56 overflow-y-auto border-t border-neutral-800 light:border-neutral-200 bg-neutral-950 light:bg-white px-2.5 py-1.5">
          {activity.length === 0 ? (
            <div className="text-[11px] text-neutral-500">No tool calls yet.</div>
          ) : (
            <>
              {hidden > 0 && <div className="text-[11px] text-neutral-500">…{hidden} earlier</div>}
              {activity.map((a, i) => (
                <div key={i} className="flex items-center gap-1.5 py-px text-[11px]">
                  <ToolIcon name={a.tool} className="h-3 w-3 flex-none text-neutral-500" />
                  <span className="flex-none text-neutral-300 light:text-neutral-700">{a.tool}</span>
                  {a.target && <span className="truncate text-neutral-500">{a.target}</span>}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
