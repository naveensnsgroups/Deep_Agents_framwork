import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { DynamicStructuredTool, StructuredToolInterface } from "@langchain/core/tools";

const GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/";

/**
 * GitHub's official hosted MCP server — repos, issues, PRs, code search, etc. — over the
 * same streamable-HTTP + bearer-token pattern used by every other provider key in this app.
 * A bad or scope-limited token shouldn't block opening the workspace, so failures here are
 * swallowed and reported as "0 tools connected" rather than thrown.
 */
export async function connectGithubTools(
  token: string | undefined
): Promise<{ tools: DynamicStructuredTool[]; client?: MultiServerMCPClient }> {
  if (!token) return { tools: [] };
  try {
    const client = new MultiServerMCPClient({
      github: {
        transport: "http",
        url: GITHUB_MCP_URL,
        headers: { Authorization: `Bearer ${token}` },
      },
    });
    const tools = await client.getTools();
    return { tools, client };
  } catch (err) {
    console.error("GitHub MCP connection failed:", (err as Error).message);
    return { tools: [] };
  }
}

/** Used only when a server labels none of its tools; GitHub's read tools are named this way. */
const READ_ONLY_NAME = /(^|__)(get|list|search)_/;

/**
 * Whether an MCP tool only reads. The MCP spec lets a server label each tool, and
 * @langchain/mcp-adapters keeps the label at `metadata.annotations`: GitHub's server marks its
 * read tools `readOnlyHint: true`. A tool the server labels is judged by its label alone. The name
 * is consulted only when the server labels nothing at all, and an unrecognised name counts as
 * acting — the safe side for both approval and retries.
 */
export function isReadOnlyTool(tool: StructuredToolInterface): boolean {
  // `metadata` is on every concrete LangChain tool, but not on the interface type.
  const annotations = (tool as { metadata?: { annotations?: { readOnlyHint?: unknown } } }).metadata?.annotations;
  if (annotations && typeof annotations.readOnlyHint === "boolean") return annotations.readOnlyHint;
  return READ_ONLY_NAME.test(tool.name);
}

/**
 * Approval for every GitHub tool that acts — pushing files, merging or closing a pull request,
 * deleting a file, creating a repository. These change things outside the workspace, where
 * nothing in this app can undo them, so they stop for the user exactly like a file write or a
 * shell command. Without this they ran unasked: a comment planted in the repository being read
 * could have had the agent merge or push on the user's behalf.
 *
 * Built from the tools actually connected, since the server decides what it offers. Subagents
 * inherit the main agent's interruptOn, so this covers them too.
 */
export function githubApprovals(tools: StructuredToolInterface[]): Record<string, { allowedDecisions: Array<"approve" | "edit" | "reject"> }> {
  return Object.fromEntries(
    tools.filter((t) => !isReadOnlyTool(t)).map((t) => [t.name, { allowedDecisions: ["approve", "edit", "reject"] }])
  );
}
