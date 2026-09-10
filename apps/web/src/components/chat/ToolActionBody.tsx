/**
 * Renders the body of a tool call the same way whether it's pending approval
 * (ToolCallCard, no `result` yet) or already finished (ToolBlock, `result` present) — one
 * source of truth for "what does a write_file/edit_file/execute call actually look like",
 * so an approval card and its completed counterpart never drift apart.
 */
export function DiffLines({ text, sign }: { text: string; sign: "+" | "-" }) {
  const className = sign === "+" ? "bg-green-900/30 text-green-200" : "bg-red-900/30 text-red-200";
  return (
    <>
      {text.split("\n").map((line, i) => (
        <div key={i} className={`whitespace-pre-wrap break-all px-1 ${className}`}>
          {sign} {line}
        </div>
      ))}
    </>
  );
}

interface Props {
  name: string;
  args: Record<string, unknown>;
  /** Omit while the call is still pending approval — there is no result yet. */
  result?: string;
}

export function ToolActionBody({ name, args, result }: Props) {
  if (name === "execute" && typeof args.command === "string") {
    return (
      <div className="font-mono text-xs">
        <div className="whitespace-pre-wrap break-all text-green-400">$ {args.command}</div>
        {result !== undefined && <pre className="mt-1.5 max-h-56 overflow-auto whitespace-pre-wrap text-neutral-300">{result}</pre>}
      </div>
    );
  }

  if (name === "edit_file" && typeof args.old_string === "string" && typeof args.new_string === "string") {
    return (
      <div className="max-h-64 overflow-auto font-mono text-xs">
        {typeof args.file_path === "string" && <div className="mb-1 break-all text-neutral-400">{args.file_path}</div>}
        <DiffLines text={args.old_string} sign="-" />
        <DiffLines text={args.new_string} sign="+" />
        {result !== undefined && <div className="mt-1.5 whitespace-pre-wrap text-[11px] text-neutral-500">{result}</div>}
      </div>
    );
  }

  if (name === "write_file" && typeof args.content === "string") {
    return (
      <div className="max-h-64 overflow-auto font-mono text-xs">
        {typeof args.file_path === "string" && <div className="mb-1 break-all text-neutral-400">{args.file_path}</div>}
        <DiffLines text={args.content} sign="+" />
        {result !== undefined && <div className="mt-1.5 whitespace-pre-wrap text-[11px] text-neutral-500">{result}</div>}
      </div>
    );
  }

  return (
    <div>
      {Object.keys(args).length > 0 && (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all text-xs text-neutral-200">{JSON.stringify(args, null, 2)}</pre>
      )}
      {result !== undefined && (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all text-xs text-neutral-200">{result}</pre>
      )}
    </div>
  );
}
