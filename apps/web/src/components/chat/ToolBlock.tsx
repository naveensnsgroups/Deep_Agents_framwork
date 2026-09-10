import { useState } from "react";
import { ChevronDown, ChevronRight, CheckCircle2, XCircle } from "lucide-react";
import type { ToolResultInfo } from "@deepagents-ide/shared";
import { ToolIcon } from "../../lib/toolIcons";
import { ToolActionBody } from "./ToolActionBody";

function summaryFor(args: Record<string, unknown>): string {
  for (const key of ["path", "file_path", "command", "pattern"]) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/**
 * `status` comes straight from LangChain's ToolMessage and is reliable for a thrown
 * exception (an MCP call, a genuine crash). It is not reliable on its own for the
 * built-in filesystem tools, which report a failure as plain text ("Error: ...") rather
 * than throwing — so this also checks for that literal, deepagents' own error-reporting
 * convention, rather than claiming certainty status:"success" doesn't actually have.
 */
function failed(result: ToolResultInfo): boolean {
  if (result.status === "error") return true;
  return /^error[:\s]/i.test(result.result.trim());
}

export function ToolBlock({ result }: { result: ToolResultInfo }) {
  const [open, setOpen] = useState(false);
  const summary = summaryFor(result.args);
  const isFailed = failed(result);

  return (
    <div className={`mb-1.5 overflow-hidden rounded-md border ${isFailed ? "border-red-900/60" : "border-neutral-800"}`}>
      <button
        className="flex w-full cursor-pointer items-center gap-2 border-none bg-neutral-900 px-2.5 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-800"
        onClick={() => setOpen((o) => !o)}
      >
        <ToolIcon name={result.name} className="h-3.5 w-3.5 flex-none text-neutral-400" />
        <span className="font-semibold">{result.name}</span>
        {summary && <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-neutral-500">{summary}</span>}
        {isFailed ? (
          <XCircle className="h-3.5 w-3.5 flex-none text-red-400" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 flex-none text-green-500/70" />
        )}
        {open ? <ChevronDown className="h-3.5 w-3.5 text-neutral-600" /> : <ChevronRight className="h-3.5 w-3.5 text-neutral-600" />}
      </button>
      {open && (
        <div className="border-t border-neutral-800 bg-neutral-950 px-2.5 py-2">
          <ToolActionBody name={result.name} args={result.args} result={result.result} />
        </div>
      )}
    </div>
  );
}
