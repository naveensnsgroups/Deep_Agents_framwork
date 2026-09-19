import { Router } from "express";
import type { AgentSubagentInfo } from "@deepagents-ide/shared";
import { listSkills } from "../agent/skills.js";

export const BUILTIN_TOOLS = [
  { name: "ls", description: "List files in a directory" },
  { name: "read_file", description: "Read file contents (with pagination)" },
  { name: "write_file", description: "Create new files" },
  { name: "edit_file", description: "Perform exact string replacements in files" },
  { name: "delete", description: "Delete a file (requires approval, same as write/edit)" },
  { name: "glob", description: "Find files matching a glob pattern" },
  { name: "grep", description: "Search file contents" },
  { name: "execute", description: "Run shell commands in the workspace" },
  { name: "task", description: "Spawn a subagent to handle a delegated task" },
  { name: "write_todos", description: "Track a multi-step plan as a todo list" },
  { name: "record_migration", description: "Record per-file migration outcomes in the durable ledger" },
  { name: "ask_user", description: "Pause and ask you a question, then continue with your answer" },
];

export function agentInfoRouter(systemPrompt: string, subagents: AgentSubagentInfo[]) {
  const router = Router();
  router.get("/agent-info", (_req, res) => {
    res.json({ systemPrompt, tools: BUILTIN_TOOLS, subagents, skills: listSkills() });
  });
  return router;
}
