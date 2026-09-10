import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function readPrompt(...segments: string[]): string {
  return fs.readFileSync(path.join(__dirname, "prompts", ...segments), "utf-8").trim();
}

export const SYSTEM_PROMPT = readPrompt("system-prompt.md");

const SHARED_SUBAGENT_RULES = readPrompt("subagents", "_shared.md");

/** Every subagent gets the same grounding/citation/context rules appended to its own brief. */
export function subagentPrompt(file: string): string {
  return `${readPrompt("subagents", file)}\n\n${SHARED_SUBAGENT_RULES}`;
}
