/**
 * `odu mcp` — the agent face. An MCP stdio server that re-exposes the live run
 * as agent tools + subscribable resources, so a coding agent (Claude Code,
 * Codex, opencode, Gemini CLI) drives CI with structured calls instead of
 * scraping terminal output.
 *
 * The whole face is now a thin composition over `@kolu/surface-mcp`: project
 * the coordinator surface (A) onto the agent surface (B) with `projectSurface`
 * (src/mcp/agentSurface.ts), then `serveSurfaceAsMcp` the projection. In-band,
 * like `status` / `logs` / `attach`: the live-client factory dials
 * `.ci/odu.sock` in the cwd, and which boxes run the lanes stays the
 * coordinator's job (pool lease / hosts.json).
 *
 * Default-deny `expose`: only the `nodes` cell + `logs` collection (as
 * resources) and `node.rerun` (as a tool) reach the host; the coordinator's
 * `header` cell and the lane-only `run.configure` are unreachable by
 * construction. Bespoke tools: `run`, `wait_for_settle`, `cancel`, `runs`,
 * plus agent-held venue `lease` / `release` (cross-run hold).
 * (`run.cancel` is the surface mutation `cancel` drives; it's not exposed
 * directly — the tool also confirms teardown.)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { directLink } from "@kolu/surface/links/direct";
import { serveSurfaceAsMcp } from "@kolu/surface-mcp";
import { buildAgentProjection, redialingAClient } from "../mcp/agentSurface";
import { cancelTool } from "../mcp/cancelTool";
import { leaseTool, releaseTool } from "../mcp/leaseTool";
import { killRuns, runTool } from "../mcp/runTool";
import { runsTool } from "../mcp/runsTool";
import { makeWaitTool } from "../mcp/waitTool";
import { gitRunContext } from "../common/git";
import { oduSurface } from "../common/surface";
import { SOCKET_PATH, tryDialSocket } from "../coordinator/socket";


function version(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(here, "../../package.json"), "utf-8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    // best-effort: the version is cosmetic in the MCP handshake, so a missing
    // or unreadable package.json falls back rather than failing server startup.
    return "0.0.0";
  }
}

/** Serve the agent MCP face over stdio until the client disconnects
 *  (stdin EOF / server close). */
export async function mcpCommand(socketPath: string = SOCKET_PATH): Promise<number> {
  const projection = buildAgentProjection(oduSurface, gitRunContext);

  // One stable B-client over a *re-dialing* A-client: the projection is wired
  // once, but every upstream call inside it dials a fresh `.ci/odu.sock`. So a
  // run that starts (or restarts on the same path) after the server booted is
  // observed by the next read/subscribe — without relying on the adapter's
  // memoized connection to re-dial. Each `nodes` read and log follow re-subscribe
  // (re-dial) afresh; `wait_for_settle` holds ONE subscription dialed at call
  // time, so it observes the coordinator live when it subscribes, not one that
  // starts later — the run → wait_for_settle agent loop is safe because `run`
  // blocks until the socket is live before returning. No socket → the A-client
  // yields the no-run value, so `nodes`/`wait_for_settle` read `{ run: false }`,
  // `logs` reads the durable file, and `run` (which ignores the client) spawns a
  // coordinator.
  const aClient = redialingAClient(async () => {
    const dialed = await tryDialSocket(socketPath);
    return dialed === null ? null : { client: dialed.client, close: dialed.close };
  });
  const { router } = projection.implement(aClient);
  const bClient = directLink<typeof projection.surface.contract>(router);

  const { server, close } = await serveSurfaceAsMcp({
    surface: projection.surface,
    // The adapter memoizes one connection for reads/tools; the freshness lives
    // a layer down, in the re-dialing A-client, so this can be the bare,
    // already-built B-client (nothing per-call to dispose here).
    client: () => bClient,
    expose: {
      nodes: "resource",
      logs: "resource",
      "node.rerun": { tool: { mutates: true } },
    },
    tools: {
      run: runTool,
      wait_for_settle: makeWaitTool(gitRunContext),
      cancel: cancelTool,
      runs: runsTool,
      lease: leaseTool,
      release: releaseTool,
    },
    serverInfo: { name: "odu", version: version() },
  });

  // Serve until the client disconnects (the StdioServerTransport closes on
  // stdin EOF) or a signal. The server owns stdin/stdout; we just await the
  // close, reaping any background runs the `run` tool spawned.
  await new Promise<void>((resolve) => {
    const shutdown = (): void => resolve();
    server.onclose = shutdown;
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  killRuns();
  await close();
  return 0;
}
