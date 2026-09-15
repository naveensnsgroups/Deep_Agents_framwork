import fs from "node:fs";
import path from "node:path";
import { SKILLS_DIR } from "./paths.js";

/**
 * Parses only the frontmatter block of a SKILL.md — never the body, which can be arbitrary
 * markdown and is not needed here. Wrapped values (a description spanning multiple lines)
 * are folded back onto their key, since the Agent Skills format allows that.
 */
export function frontmatterOf(dir: string): Record<string, string> {
  const raw = fs.readFileSync(path.join(SKILLS_DIR, dir, "SKILL.md"), "utf-8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return {};

  const fields: Record<string, string> = {};
  let key = "";
  for (const line of match[1].split(/\r?\n/)) {
    const start = /^([a-zA-Z-]+):\s*(.*)$/.exec(line);
    if (start) {
      key = start[1];
      fields[key] = start[2];
    } else if (key && line.trim()) {
      fields[key] += ` ${line.trim()}`;
    }
  }
  return fields;
}

export interface SkillInfo {
  name: string;
  description: string;
}

/**
 * The same name/description pair the agent itself sees at discovery time — surfaced here so
 * the UI can show which playbooks are actually mounted, without a person having to read the
 * skills directory on disk to find out.
 */
export function listSkills(): SkillInfo[] {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .map((dir) => {
      const fm = frontmatterOf(dir);
      return { name: fm.name ?? dir, description: fm.description ?? "" };
    });
}
