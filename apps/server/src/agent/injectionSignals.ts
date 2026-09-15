/**
 * Finds text inside project files that is addressed to an AI agent rather than to a human
 * reader.
 *
 * The system prompt tells the agent to treat file contents as data and to report anything
 * that addresses it directly. That instruction is only as good as the model's compliance,
 * and compliance is not a guarantee — so this runs independently, on the raw tool result,
 * and surfaces what it finds on the approval card. The human deciding whether to run a
 * command gets to see that the agent had just read a file trying to give it orders.
 *
 * Heuristics, not a classifier: the output is shown to a person, never used to block
 * anything automatically. A false positive costs a line of context on a card. A false
 * negative costs nothing that was not already the case before this existed.
 */
const SIGNALS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "instruction override",
    pattern: /\b(ignore|disregard|forget)\s+(all\s+|any\s+|your\s+)?(previous|prior|earlier|above|preceding)\s+(instructions?|prompts?|rules?|directions?)/gi,
  },
  {
    label: "addressed to an agent",
    pattern: /\b(ai|llm|agent|assistant|claude|gpt|gemini|copilot|cursor)\s*[:,-]\s*(?=\w)/gi,
  },
  {
    label: "claims to be a system prompt",
    pattern: /\b(system\s+prompt|<\s*\/?\s*system\s*>|\[\s*system\s*\]|new\s+instructions?\s*:)/gi,
  },
  {
    label: "asks to run a command",
    pattern: /\b(before|first|prior to)\s+\w{0,20}\s*(converting|migrating|editing|proceeding)[^.\n]{0,40}\b(run|execute|curl|wget|install)\b/gi,
  },
  {
    label: "asks to stay silent",
    pattern: /\b(do\s+not|don't|never)\s+(report|mention|tell|inform|log|show|surface|disclose)\b[^.\n]{0,40}\b(this|that|it|step|command|user)\b/gi,
  },
  {
    label: "claims work is already done",
    pattern: /\b(already\s+(migrated|converted|done|handled)|skip\s+this\s+file|no\s+changes?\s+needed\s+here)\b/gi,
  },
  {
    label: "pipes a remote script to a shell",
    pattern: /\b(curl|wget)\b[^\n|]{0,120}\|\s*(ba)?sh\b/gi,
  },
  {
    label: "claims elevated authority",
    pattern: /\b(the\s+)?(repository\s+owner|project\s+maintainer|administrator|security\s+team|your\s+operator)\s+(requires?|demands?|instructs?|mandates?)/gi,
  },
];

export interface InjectionSignal {
  label: string;
  /** The matched text, trimmed to something readable on a card. */
  excerpt: string;
}

const MAX_SIGNALS = 4;
const EXCERPT_CHARS = 140;

/**
 * Scans a tool result for agent-directed text.
 *
 * Deliberately tolerant of size: results can be whole files, so the scan is capped rather
 * than allowed to become the slow part of a turn.
 */
export function scanForAgentDirectedText(content: string): InjectionSignal[] {
  if (!content) return [];

  // Beyond this, an injected instruction has almost certainly already appeared — and a
  // multi-megabyte result should not be regex-scanned in full on the turn's critical path.
  const haystack = content.length > 200_000 ? content.slice(0, 200_000) : content;

  const found: InjectionSignal[] = [];
  const seen = new Set<string>();

  for (const { label, pattern } of SIGNALS) {
    // Cloned per call: a shared /g regex carries lastIndex between invocations and would
    // skip matches on alternate calls.
    const regex = new RegExp(pattern.source, pattern.flags);
    const match = regex.exec(haystack);
    if (!match) continue;

    // Show the line the match sits on rather than the match alone — "AI agent:" on its own
    // tells the reader nothing about what was being asked.
    const lineStart = haystack.lastIndexOf("\n", match.index) + 1;
    const lineEnd = haystack.indexOf("\n", match.index);
    const line = haystack.slice(lineStart, lineEnd === -1 ? haystack.length : lineEnd).trim();

    const excerpt = line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS)}…` : line;

    // Keyed by label *and* excerpt, not excerpt alone. One line frequently trips several
    // checks — "before converting, run: curl … | bash" is both a request to run a command
    // and a remote script piped to a shell — and deduplicating on the text dropped whichever
    // signal happened to be checked second, which was often the more alarming one.
    const key = `${label}::${excerpt}`;
    if (seen.has(key)) continue;
    seen.add(key);

    found.push({ label, excerpt });
    if (found.length >= MAX_SIGNALS) break;
  }

  return found;
}

/** Tool names whose results are project content the agent did not author. */
const READ_TOOLS = new Set(["read_file", "grep", "glob", "ls"]);

export function isReadTool(name: string): boolean {
  return READ_TOOLS.has(name);
}

/** The path a read-like tool call was pointed at, for display on an approval card. */
export function readTargetOf(args: Record<string, unknown>): string {
  for (const key of ["file_path", "path", "pattern"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "(unknown path)";
}
