export type ModelId = string;

export interface ProviderOption {
  id: string;
  label: string;
  defaultModel: string;
  /** Whether the server has a key for this provider in its env; the key itself is never sent. */
  serverKey: boolean;
  /** Whether the signed-in user has saved their own key for this provider. Only under GitHub login. */
  userKey?: boolean;
  keyPlaceholder: string;
}

/**
 * "oauth" — GitHub login, per-user keys and data. "token" — one shared AUTH_TOKEN, everyone is
 * the same user. "none" — local development with no authentication.
 */
export type AuthMode = "oauth" | "token" | "none";

export interface HealthInfo {
  ok: boolean;
  authRequired: boolean;
  authMode: AuthMode;
}

export interface SessionUser {
  id: string;
  login: string;
  name?: string;
  avatarUrl?: string;
}

/** What a user can save in "My keys": one entry per model provider, plus a GitHub PAT. */
export type UserKeyName = "anthropic" | "google-genai" | "openai" | "openrouter" | "github";

export interface KeyStatus {
  name: UserKeyName;
  label: string;
  saved: boolean;
  /** ISO timestamp of the last save. */
  updatedAt?: string;
}

export interface MeResponse {
  user: SessionUser;
  authMode: AuthMode;
}

export interface KeysResponse {
  keys: KeyStatus[];
  /** Whether GitHub login granted repository access, used for clone and push when no PAT is saved. */
  githubLinked: boolean;
}

export interface ActionRequest {
  name: string;
  args: Record<string, unknown>;
  description?: string;
}

export interface ReviewConfig {
  actionName: string;
  allowedDecisions: Array<"approve" | "edit" | "reject">;
}

/** Text in a project file that addresses an AI agent rather than a human reader. */
export interface InjectionSignal {
  label: string;
  excerpt: string;
}

/**
 * What the agent read just before proposing the action awaiting approval.
 *
 * Without this, an approval card shows a command with no indication of where it came from —
 * so a command the agent reasoned its way to and one a file told it to run look identical at
 * the moment you have to decide. The agent reads repositories nobody in the conversation
 * wrote, which makes that distinction the whole point of the review step.
 */
export interface ReadProvenance {
  /** The file or pattern the read targeted. */
  target: string;
  tool: string;
  /** Non-empty when the file contained text aimed at an agent. */
  signals: InjectionSignal[];
}

export interface ToolResultInfo {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  result: string;
  /** From LangChain's own ToolMessage.status — reliable for a thrown exception (e.g. an
   * MCP tool error), but the built-in filesystem tools report failures as plain text in
   * `result` rather than throwing, so "success" here does not guarantee the tool call
   * itself did what was asked. */
  status?: "success" | "error";
}

export interface WorkspaceOptions {
  /** User-supplied API key, kept in server memory for this session only — never written to disk. */
  apiKey?: string;
  /** Globs whose writes skip the approval prompt (e.g. a migration target directory). */
  autoApprovePaths?: string[];
  /** Globs whose writes can never be auto-approved (e.g. the legacy source tree). */
  readOnlyPaths?: string[];
  /** Provider-prefixed models to fall back to if the primary model call fails. */
  fallbackModels?: string[];
  /** GitHub Personal Access Token — connects GitHub's official MCP server (repos, issues, PRs). Server-memory only. */
  githubToken?: string;
}

export type ClientToServerMessage =
  | { type: "set_workspace"; projectRoot: string; model: ModelId; options?: WorkspaceOptions }
  | { type: "user_message"; content: string }
  | {
      type: "resume_decisions";
      decisions: Array<
        | { type: "approve" }
        | { type: "reject"; message?: string }
        | { type: "edit"; editedAction: { name: string; args: Record<string, unknown> } }
      >;
    }
  | { type: "clear_chat" }
  | { type: "edit_message"; userMessageIndex: number; content: string }
  | { type: "stop" }
  | { type: "push_changes" };

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed" | string;
}

/** Per-file migration outcome — accumulates across a run, unlike the todo list. */
export interface LedgerEntry {
  path: string;
  target: string;
  status: "pending" | "converted" | "verified" | "failed" | "skipped" | string;
  note: string;
}

export type ServerToClientMessage =
  | { type: "workspace_ready"; projectRoot: string; githubTools?: number; isGitWorkspace?: boolean }
  | { type: "push_result"; pushed: boolean; detail: string }
  | { type: "agent_thinking" }
  | { type: "user_message_replay"; content: string }
  | { type: "agent_message_start"; id: string }
  | { type: "agent_message_delta"; id: string; delta: string }
  | { type: "agent_message_end"; id: string }
  | { type: "tool_call_result"; results: ToolResultInfo[] }
  | {
      type: "interrupt_request";
      actionRequests: ActionRequest[];
      reviewConfigs: ReviewConfig[];
      /** Files read immediately before this action was proposed — see ReadProvenance. */
      provenance?: ReadProvenance[];
    }
  | { type: "todo_update"; todos: Todo[] }
  | { type: "ledger_update"; entries: LedgerEntry[] }
  | { type: "chat_cleared" }
  | { type: "error"; message: string }
  | { type: "turn_end" };

export interface BrowseEntry {
  name: string;
  path: string;
}

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: FileNode[];
}

export interface AgentToolInfo {
  name: string;
  description: string;
}

export interface AgentSubagentInfo {
  name: string;
  description: string;
  readOnly?: boolean;
}

export interface AgentSkillInfo {
  name: string;
  description: string;
}

export interface AgentInfo {
  systemPrompt: string;
  tools: AgentToolInfo[];
  subagents: AgentSubagentInfo[];
  skills: AgentSkillInfo[];
}
