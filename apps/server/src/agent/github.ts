import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import type { DynamicStructuredTool } from "@langchain/core/tools";

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
