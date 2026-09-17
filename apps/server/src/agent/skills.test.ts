import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SKILLS_DIR } from "./paths.js";
import { frontmatterOf } from "./skills.js";

/**
 * Structural checks on the playbooks, run without a model.
 *
 * A skill with a malformed or mismatched frontmatter is not an error anyone sees — it is
 * simply never discovered, and the agent migrates without it while appearing to work. These
 * assertions are cheap and catch exactly that class of silent failure.
 */
const skillDirs = fs
  .readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

describe("skills", () => {
  it("finds at least the playbooks that ship with the app", () => {
    expect(skillDirs.length).toBeGreaterThanOrEqual(3);
  });

  it.each(skillDirs)("%s has a SKILL.md", (dir) => {
    expect(fs.existsSync(path.join(SKILLS_DIR, dir, "SKILL.md"))).toBe(true);
  });

  it.each(skillDirs)("%s declares a name matching its directory", (dir) => {
    // The spec requires this. A mismatch means the skill is never loaded, with no error.
    expect(frontmatterOf(dir).name).toBe(dir);
  });

  it.each(skillDirs)("%s frontmatter stays within the Agent Skills spec limits", (dir) => {
    const fields = frontmatterOf(dir);
    // Documented limits; a field past them can be truncated or rejected at load time.
    expect(fields.name ?? "").toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect((fields.name ?? "").length).toBeLessThanOrEqual(64);
    expect((fields.description ?? "").length).toBeLessThanOrEqual(1024);
    if (fields.compatibility !== undefined) expect(fields.compatibility.length).toBeLessThanOrEqual(500);
  });

  it.each(skillDirs)("%s has a description that says what and when", (dir) => {
    const description = frontmatterOf(dir).description ?? "";
    // The description is the only text in context at discovery, so it alone decides whether
    // the skill is ever opened. Too short means it cannot be matched against real work.
    expect(description.length).toBeGreaterThan(80);
    // It must also say *when* to reach for the skill, not only what it covers. Any of the
    // usual phrasings count — an earlier version of this test demanded the literal "use
    // when" and failed a description that said "Use at the start of any migration", which
    // answers the question perfectly well.
    expect(description.toLowerCase()).toMatch(/\buse\s+(when|at|after|before|for|during|on|in)\b/);
  });

  it.each(skillDirs)("%s body stays within the token guidance", (dir) => {
    const body = fs.readFileSync(path.join(SKILLS_DIR, dir, "SKILL.md"), "utf-8");
    // ~5k tokens is the Agent Skills guidance; 4 chars per token is the usual rough ratio.
    // Anything over this is detail that belongs in references/.
    expect(body.length).toBeLessThan(20_000);
  });

  it.each(skillDirs)("%s only references files that exist", (dir) => {
    const body = fs.readFileSync(path.join(SKILLS_DIR, dir, "SKILL.md"), "utf-8");
    // Level-3 files are loaded only when the body names them, so a typo here is a reference
    // the agent will look for and never find.
    for (const m of body.matchAll(/`((?:references|scripts)\/[\w.-]+)`/g)) {
      expect(fs.existsSync(path.join(SKILLS_DIR, dir, m[1])), `${dir} → ${m[1]}`).toBe(true);
    }
  });
});
