import * as z from "zod";
import { createMiddleware } from "langchain";
import { tool } from "@langchain/core/tools";
import { Command, getCurrentTaskInput } from "@langchain/langgraph";
import { ToolMessage } from "@langchain/core/messages";

/**
 * Kept to plain strings and a closed enum — no `.optional()`, `.min()` or nullable unions,
 * whose emitted JSON Schema keywords Gemini rejects (same constraint as the
 * dependency-mapper response format; see routes/geminiProxy.ts).
 */
export const LedgerEntrySchema = z.object({
  path: z.string().describe("Path of the source file this entry is about"),
  target: z.string().describe("Path the migrated output was written to, or an empty string if nothing is written yet"),
  status: z
    .enum(["pending", "converted", "verified", "failed", "skipped"])
    .describe("converted = written but not yet proven; verified = built or tested successfully"),
  note: z.string().describe("Short detail — required for failed and skipped, otherwise may be empty"),
});

export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

const stateSchema = z.object({
  migrationLedger: z.array(LedgerEntrySchema).default([]),
});

const RECORD_MIGRATION_DESCRIPTION = `Record the migration status of specific files in the migration ledger.

The ledger is the durable record of what has actually been migrated. Unlike the todo list,
which tracks what you plan to do next, the ledger tracks per-file outcomes and survives
context summarization — so after a long run it is what tells you, and the user, which files
are genuinely done.

Call this as you go, not in one batch at the end:
- after a converter writes a file, record it as "converted"
- after a verifier builds or tests it successfully, update it to "verified"
- when something cannot be migrated, record "failed" or "skipped" with the reason in note

Send only the entries that changed; existing entries for other paths are preserved, and an
entry for a path you send again replaces the previous one for that path.

Do not mark anything "verified" that you have not actually built or tested.`;

const LEDGER_SYSTEM_PROMPT = `## Migration ledger

Use \`record_migration\` to keep a per-file record of migration outcomes. Record a file as
"converted" when it is written, and update it to "verified" only once a build or test has
actually passed for it. The ledger is what survives a long run, so keeping it current is
what lets you report real progress instead of guessing.`;

/**
 * Per-file migration outcomes, persisted in agent state.
 *
 * Todos cover intent for the current stretch of work and get rewritten constantly; this is
 * the opposite: an accumulating record of what happened to each file, which stays accurate
 * across summarization and reconnects because it lives in the checkpointed state rather
 * than in the conversation.
 */
export function migrationLedgerMiddleware() {
  const recordMigration = tool(
    ({ entries }: { entries: LedgerEntry[] }, config) => {
      let existing: LedgerEntry[] = [];
      try {
        existing = (getCurrentTaskInput() as { migrationLedger?: LedgerEntry[] }).migrationLedger ?? [];
      } catch {
        // Called outside a graph run (no task input available) — start from empty rather
        // than failing the tool call.
      }

      const byPath = new Map(existing.map((entry) => [entry.path, entry]));
      for (const entry of entries) byPath.set(entry.path, entry);
      const migrationLedger = [...byPath.values()];

      const counts = migrationLedger.reduce<Record<string, number>>((acc, entry) => {
        acc[entry.status] = (acc[entry.status] ?? 0) + 1;
        return acc;
      }, {});

      return new Command({
        update: {
          migrationLedger,
          messages: [
            new ToolMessage({
              content: `Recorded ${entries.length} file(s). Ledger now: ${JSON.stringify(counts)}`,
              tool_call_id: config.toolCall?.id ?? "",
              name: "record_migration",
            }),
          ],
        },
      });
    },
    {
      name: "record_migration",
      description: RECORD_MIGRATION_DESCRIPTION,
      schema: z.object({ entries: z.array(LedgerEntrySchema).describe("Only the entries whose status changed") }),
    }
  );

  return createMiddleware({
    name: "migrationLedgerMiddleware",
    stateSchema,
    tools: [recordMigration],
    wrapModelCall: (request, handler) =>
      handler({ ...request, systemMessage: request.systemMessage.concat(`\n\n${LEDGER_SYSTEM_PROMPT}`) }),
  });
}
