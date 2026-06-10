/**
 * `odu mcp` — serve the agent face over stdio. Thin entry: the MCP server
 * itself lives in src/mcp/. Runs until the client disconnects (stdin EOF).
 */

import { runMcpServer } from "../mcp/server";

export async function mcpCommand(): Promise<number> {
  await runMcpServer();
  return 0;
}
