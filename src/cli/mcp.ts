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
 * resources) and `node.cancel` / `lane.cancel` (as tools) reach the host; the
 * coordinator's `header` cell and the lane-only `run.configure` are unreachable
 * by construction. Bespoke tools: `run`, `node_rerun`, `wait_for_settle`,
 * `cancel`, `runs`, plus agent-held venue `lease` / `release` (cross-run hold).
 * (`run.cancel` is the surface mutation full-run `cancel` drives; it's not
 * exposed directly — the tool also confirms teardown. Per-node cancel is
 * `node_cancel`; per-platform is `lane_cancel`.)
 *
 * `node_rerun` is bespoke rather than `expose`d for one reason: a
 * procedure-exposed tool cannot carry a DESCRIPTION (`ToolExposure` has no
 * field for one), and `node_rerun` — the cheap, non-destructive way to retry a
 * single lane — shipped with none at all while `run`'s described `supersede`
 * read like the way to have another go. src/mcp/rerunTool.ts carries the whole
 * account.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSurfaceFace } from "@kolu/surface/client";
import { directDispatch } from "@kolu/surface/links/direct";
import {
  serveSurfaceAsMcp,
  type SurfaceClientCallable,
} from "@kolu/surface-mcp";
import { oduSurface } from "@odu/run-client/surface";
import { SOCKET_PATH } from "@odu/run-client/dial";
import {
  buildAgentProjection,
  dialAFor,
  redialingAClient,
} from "../mcp/agentSurface";
import { cancelTool } from "../mcp/cancelTool";
import { leaseTool, releaseTool } from "../mcp/leaseTool";
import { killRuns, runTool } from "../mcp/runTool";
import { rerunTool } from "../mcp/rerunTool";
import { runsTool } from "../mcp/runsTool";
import { makeWaitTool } from "../mcp/waitTool";
import { gitRunContext } from "../common/git";

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
  // (re-dial) afresh; `wait_for_settle` dials at call time, so it observes the
  // coordinator live when it subscribes, not one that starts later — the run →
  // wait_for_settle agent loop is safe because `run` blocks until the socket is
  // live before returning — and re-dials if that link dies under a run still
  // going (see `waitForSettle`'s read loop). `odu wait` builds the same reader
  // over the same `dialAFor`, which is why the two faces cannot disagree about
  // a run. No socket → the A-client yields the no-run value, so
  // `nodes`/`wait_for_settle` read `{ run: false }`, `logs` reads the durable
  // file, and `run` (which ignores the client) spawns a coordinator.
  const aClient = redialingAClient(dialAFor(socketPath));
  // `directDispatch` over the served handlers is the in-process transport: a
  // tag-keyed dispatcher that invokes each handler effect directly, with zero
  // serialization and no wire at all. `buildSurfaceFace` re-nests those flat
  // tags into the `surface.<member>.<verb>` face the MCP adapter drives — the
  // SAME two layers a real socket link produces, which is why the adapter
  // cannot tell the two apart.
  // The cast is the one `buildSurfaceFace` always needs at an adapter seam: the
  // face is deliberately STRUCTURAL (`Record<string, Record<string, unknown>>`)
  // because per-member precision lives one layer up, and the adapter wants the
  // callable-leaved view of the same object. Same cast kolu.s own
  // surface-mcp composition test makes, for the same reason.
  const bClient = buildSurfaceFace(
    projection.surface,
    directDispatch(projection.implement(aClient)),
  ) as unknown as SurfaceClientCallable;

  const { server, close } = await serveSurfaceAsMcp({
    surface: projection.surface,
    // The adapter memoizes one connection for reads/tools; the freshness lives
    // a layer down, in the re-dialing A-client, so this can be the bare,
    // already-built B-client (nothing per-call to dispose here).
    client: () => bClient,
    expose: {
      nodes: "resource",
      logs: "resource",
      // `node.rerun` is NOT here — it ships as the bespoke `node_rerun` below,
      // which is the only door that carries a description (see rerunTool.ts).
      "node.cancel": { tool: { mutates: true } },
      "lane.cancel": { tool: { mutates: true } },
    },
    tools: {
      run: runTool,
      node_rerun: rerunTool,
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
