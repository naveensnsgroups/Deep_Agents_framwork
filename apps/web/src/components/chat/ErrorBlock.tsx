import { useState } from "react";
import { AlertCircle, ChevronDown, ChevronRight, Copy, CopyCheck } from "lucide-react";

/**
 * A real provider error (e.g. a Gemini 429 with its retry-info payload) is a single long
 * line, often over a thousand characters, with URLs and no natural break points. This was
 * the actual, confirmed cause of the chat panel scrolling horizontally — a plain
 * unstyled status div with no wrap rule at all. Diagnosed by binary-searching which
 * timeline item was pushing the scroller's scrollWidth past its clientWidth, not
 * guessed: earlier fix attempts targeted markdown tables and code blocks (also real
 * gaps, and now fixed), but neither was the actual culprit here.
 */
export function ErrorBlock({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const firstLine = content.split("\n")[0];
  const hasMore = content.length > firstLine.length;

  function copy() {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="rounded-lg border border-red-900 bg-red-950/40 p-2.5 text-red-100">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 flex-none text-red-400" />
        <div className="min-w-0 flex-1">
          <div className="break-words text-xs leading-relaxed">{firstLine}</div>
          {expanded && hasMore && (
            <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-950/60 p-1.5 text-[11px] text-red-200/90">
              {content}
            </pre>
          )}
        </div>
        <button
          onClick={copy}
          title="Copy full error"
          className="flex-none cursor-pointer text-red-400/70 hover:text-red-200"
        >
          {copied ? <CopyCheck className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      {hasMore && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="mt-1 flex cursor-pointer items-center gap-0.5 text-[11px] text-red-400/80 hover:text-red-200"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {expanded ? "Hide details" : "Show details"}
        </button>
      )}
    </div>
  );
}
