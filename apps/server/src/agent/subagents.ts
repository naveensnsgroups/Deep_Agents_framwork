import * as z from "zod";
import {
  createFilesystemMiddleware,
  type AnyBackendProtocol,
  type BackendFactory,
  type FilesystemPermission,
  type FsToolName,
  type SubAgent,
} from "deepagents";
import { subagentPrompt } from "./prompts.js";
import { SKILLS_MOUNT } from "./paths.js";

/**
 * The real backend is a factory (built in index.ts) so its `/large_tool_results/` and
 * `/conversation_history/` routes can bind to each run's live LangGraph state — see the
 * comment there. `createFilesystemMiddleware` resolves either shape itself.
 */
type Backend = AnyBackendProtocol | BackendFactory;

/** Read and search only — no write, edit, delete, or shell. */
const INSPECT: FsToolName[] = ["read_file", "ls", "glob", "grep"];
/** Reads and writes files, but cannot run shell commands. */
const EDIT_NO_SHELL: FsToolName[] = ["read_file", "ls", "glob", "grep", "write_file", "edit_file"];
/** Reads and runs commands, but cannot modify any file. */
const RUN_NO_WRITE: FsToolName[] = ["read_file", "ls", "glob", "grep", "execute"];

/**
 * Permission rules are only legal on a shell-capable backend when the subagent has no
 * `execute` tool (deepagents throws otherwise, since a shell can reach any path and make
 * path rules meaningless). So these are attached only to the no-shell subagents — for
 * them the protected globs are enforced by the framework, not merely gated on approval.
 */
function denyWrites(protectedPaths: string[]): FilesystemPermission[] {
  const paths = protectedPaths
    .map((p) => p.trim().replace(/\\/g, "/"))
    .filter(Boolean)
    .map((p) => (p.startsWith("/") ? p : `/${p}`));
  return paths.length > 0 ? [{ operations: ["write"], paths, mode: "deny" }] : [];
}

/**
 * Replaces the subagent's default filesystem middleware. deepagents merges middleware by
 * name, so passing the same factory here overrides the built-in one rather than stacking
 * a second copy.
 */
function restrictTools(backend: Backend, tools: FsToolName[], permissions: FilesystemPermission[] = []) {
  return [createFilesystemMiddleware({ backend, tools, permissions })];
}

/**
 * Filesystem tool set per subagent. Anything not listed keeps the full default set
 * (it genuinely needs both to write files and to run commands).
 */
const TOOLSETS: Record<string, FsToolName[]> = {
  analyzer: INSPECT,
  "dependency-mapper": INSPECT,
  "pattern-cataloguer": EDIT_NO_SHELL,
  converter: EDIT_NO_SHELL,
  verifier: RUN_NO_WRITE,
  "security-reviewer": INSPECT,
  "skill-author": EDIT_NO_SHELL,
};

/**
 * skill-author writes playbooks and nothing else. Framework-enforced rather than asked for:
 * it is pointed at a finished migration, so the project's own files are sitting right there,
 * and "only write under /skills/" is the kind of boundary that should not depend on a prompt.
 *
 * First-match-wins, so the allow has to precede the deny — reversed, the deny would swallow
 * every write including the ones this subagent exists to make.
 */
const SKILLS_ONLY_WRITE: FilesystemPermission[] = [
  { operations: ["write"], paths: [`${SKILLS_MOUNT}**`], mode: "allow" },
  { operations: ["write"], paths: ["/**"], mode: "deny" },
];

const MUTATING_TOOLS: FsToolName[] = ["write_file", "edit_file", "delete"];

/** Specs without a backend attached, so the UI metadata can be derived without building one. */
function baseSpecs(): SubAgent[] {
  return [
    {
      name: "analyzer",
      description:
        "Read-only inventory and assessment of a scope: which files exist, what stack is actually in use, and what will resist mechanical migration. Use before planning anything, to keep large file reads out of the main conversation.",
      systemPrompt: subagentPrompt("analyzer.md"),
    },
    {
      name: "dependency-mapper",
      description:
        "Builds the internal dependency graph for a scope and returns a leaf-first migration order plus any dependency cycles. Use after analysis to decide what to migrate first.",
      systemPrompt: subagentPrompt("dependency-mapper.md"),
      // The migration order is the one subagent result the caller acts on mechanically,
      // so it is worth enforcing a shape rather than parsing prose. Kept to plain strings,
      // arrays and numbers — Gemini rejects the constraint keywords Zod emits for
      // .optional()/.min()/etc. (see the gemini-proxy note in routes/geminiProxy.ts).
      responseFormat: z.object({
        migrationOrder: z.array(
          z.object({
            batch: z.number(),
            paths: z.array(z.string()),
          })
        ),
        cycles: z.array(
          z.object({
            paths: z.array(z.string()),
            suggestedBreak: z.string(),
          })
        ),
        entryPoints: z.array(z.string()),
        unresolved: z.array(z.string()),
        notes: z.string(),
      }),
    },
    {
      name: "pattern-cataloguer",
      description:
        "Decides the conversion rules once and writes them to /.deepagents/migration-rules.md. Run this exactly once before any conversion — it is what keeps every converted file consistent with the others.",
      systemPrompt: subagentPrompt("pattern-cataloguer.md"),
      // Custom subagents never inherit the main agent's skills — only the built-in
      // general-purpose one does (confirmed against the deepagents source and docs). Without
      // this, the playbooks mounted at /skills/ are invisible to the one subagent whose whole
      // job is deciding the conversion rules from them.
      skills: [SKILLS_MOUNT],
    },
    {
      name: "converter",
      description:
        "Migrates one file or one tightly-coupled group from source form to target form, following the rulebook. Use one call per file so each conversion gets a clean context.",
      systemPrompt: subagentPrompt("converter.md"),
      skills: [SKILLS_MOUNT],
    },
    {
      name: "config-migrator",
      description:
        "Migrates the build and configuration layer: dependency manifests, compiler/bundler config, module resolution, and scripts. Use for config changes rather than the general converter.",
      systemPrompt: subagentPrompt("config-migrator.md"),
      skills: [SKILLS_MOUNT],
    },
    {
      name: "test-migrator",
      description:
        "Migrates test files: runner, lifecycle hooks, mocks, and assertions, preserving exactly what each test asserts. Use for tests rather than the general converter.",
      systemPrompt: subagentPrompt("test-migrator.md"),
      skills: [SKILLS_MOUNT],
    },
    {
      name: "verifier",
      description:
        "Checks migrated code by running the real build and tests and comparing behavior against the source. Returns a verdict and concrete findings. Does not fix anything.",
      systemPrompt: subagentPrompt("verifier.md"),
      // Keeps `execute` (it has to actually run the build and tests) but loses every
      // file-mutating tool, so "does not fix anything" is enforced rather than requested.
      // `fork` lets it judge against the migration decisions already made in this
      // conversation instead of re-deriving them — at the cost of a larger prompt, which
      // matters on a rate-limited free-tier key.
      mode: "fork",
      // A structured verdict, rather than prose the caller has to parse, is what lets the
      // main agent decide deterministically whether to call `fixer` or `record_migration`
      // next. Plain types only — no .optional()/.min()/nullable unions — for the same
      // Gemini schema-validator reason as dependency-mapper's responseFormat above.
      responseFormat: z.object({
        verdict: z.enum(["pass", "fail", "partial"]),
        filesChecked: z.array(z.string()),
        commandsRun: z.array(z.object({ command: z.string(), result: z.string() })),
        failures: z.array(
          z.object({
            path: z.string(),
            problem: z.string(),
            sourceLine: z.string(),
          })
        ),
        parityConcerns: z.array(z.string()),
        preExisting: z.array(z.string()),
      }),
    },
    {
      name: "skill-author",
      description:
        "Turns a finished migration into a reusable playbook under /skills/, harvested from the rulebook, the verifier's failures and the fixer's repairs. Use after a migration completes, when the same translation will be done again. Writes a draft for a human to review — never the project being migrated.",
      systemPrompt: subagentPrompt("skill-author.md"),
      // It has to read the existing playbooks to avoid writing one that overlaps, and the
      // format it must follow is documented alongside them.
      skills: [SKILLS_MOUNT],
      responseFormat: z.object({
        skillName: z.string(),
        files: z.array(z.object({ path: z.string(), contains: z.string() })),
        evidence: z.array(z.object({ rule: z.string(), camefrom: z.string() })),
        omitted: z.array(z.object({ item: z.string(), reason: z.string() })),
        needsReview: z.array(z.string()),
      }),
    },
    {
      name: "security-reviewer",
      description:
        "Compares migrated code against its source for security protections that were lost in translation — dropped authorisation, weakened validation, widened error responses, reintroduced injection. Use after conversion, alongside the verifier: a missing auth check builds cleanly and passes the tests.",
      systemPrompt: subagentPrompt("security-reviewer.md"),
      // Read-only by tool set, so "does not fix anything" is enforced rather than asked for —
      // the same reasoning as the verifier, and the same reason its findings can be trusted:
      // an agent that can edit the code it is judging can quietly make its own check pass.
      // No `execute` either; this review is a read of two files, not a run of anything.
      responseFormat: z.object({
        verdict: z.enum(["pass", "fail", "partial"]),
        filesReviewed: z.array(z.object({ migrated: z.string(), source: z.string() })),
        findings: z.array(
          z.object({
            path: z.string(),
            lostProtection: z.string(),
            sourceEvidence: z.string(),
            severity: z.enum(["high", "medium", "low"]),
          })
        ),
        preExisting: z.array(z.string()),
        notes: z.string(),
      }),
    },
    {
      name: "fixer",
      description:
        "Repairs the specific findings a verifier reported, re-runs the failing check, and confirms the fix. Use after verification fails rather than fixing in the main conversation.",
      systemPrompt: subagentPrompt("fixer.md"),
    },
  ];
}

export function migrationSubagents(backend: Backend, protectedPaths: string[] = []): SubAgent[] {
  const noWriteToProtected = denyWrites(protectedPaths);

  return baseSpecs().map((spec) => {
    const tools = TOOLSETS[spec.name];
    if (!tools) return spec;
    // Path rules can only be attached where `execute` is absent; with a shell available
    // they would be unenforceable and deepagents rejects them outright.
    const canWrite = tools.some((t) => MUTATING_TOOLS.includes(t));
    const permissions = spec.name === "skill-author" ? SKILLS_ONLY_WRITE : canWrite ? noWriteToProtected : [];
    return { ...spec, middleware: restrictTools(backend, tools, permissions) };
  });
}

/** A subagent is read-only when its tool set contains nothing that can mutate a file. */
export const SUBAGENT_INFO = baseSpecs().map((sub) => {
  const tools = TOOLSETS[sub.name];
  return {
    name: sub.name,
    description: sub.description,
    readOnly: tools != null && !tools.some((t) => MUTATING_TOOLS.includes(t)),
  };
});
