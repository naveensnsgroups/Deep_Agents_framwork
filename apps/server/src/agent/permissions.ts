import micromatch from "micromatch";

/**
 * A migration touches hundreds of files; approving every single write by hand is not
 * workable. `autoApprovePaths` nominates a safe target zone (e.g. "/migrated/**") whose
 * writes run without a prompt; everything else still stops for review.
 *
 * `protectedPaths` marks the legacy source tree so its writes can never be auto-approved,
 * even if a broader auto-approve glob would otherwise cover them.
 *
 * For the main agent this is an approval gate rather than a filesystem-level block, because
 * deepagents rejects `permissions` rules on a shell-capable backend (`execute` could bypass
 * any path rule anyway). The subagents that have no shell do get real, framework-enforced
 * path rules — see `restrictTools` in subagents.ts. So the guarantee here is that every
 * shell command and every write outside the safe zone requires a human decision.
 */
export function writeInterrupt(autoApprovePaths: string[], protectedPaths: string[]) {
  return {
    allowedDecisions: ["approve", "edit", "reject"] as Array<"approve" | "edit" | "reject">,
    when: (request: { toolCall: { args: Record<string, unknown> } }) => {
      const target = request.toolCall.args.file_path ?? request.toolCall.args.path;
      if (typeof target !== "string") return true;
      // The agent's own cross-project notes live outside the user's repository entirely,
      // so prompting for each one would be noise about files the user never asked for.
      if (micromatch.isMatch(target, ["/memories/**"])) return false;
      if (protectedPaths.length > 0 && micromatch.isMatch(target, protectedPaths)) return true;
      if (autoApprovePaths.length === 0) return true;
      return !micromatch.isMatch(target, autoApprovePaths);
    },
  };
}
