/**
 * `odu mcp` — the agent face. An MCP stdio server that re-exposes the live run
 * as agent tools + subscribable resources, so a coding agent (Claude Code,
 * Codex, opencode, Gemini CLI) drives CI with structured calls instead of
 * scraping terminal output.
 *
 * The whole face is now a thin composition over `@kolu/surface-mcp`: project
 * the coordinator surface (A) onto the agent surface (B) with `projectSurface`
 * (packages/cli/src/mcp/agentSurface.ts), then `serveSurfaceAsMcp` the projection. In-band,
 * like `status` / `logs` / `attach`: the live-client factory dials
 * `.ci/odu.sock` in the cwd, and which boxes run the lanes stays the
 * coordinator's job (pool lease / hosts.json).
 *
 * Default-deny `expose`: only the `nodes` cell + `logs` collection (as
 * resources) reach the host; the coordinator's `header` cell and the lane-only
 * `run.configure` are unreachable by construction. Bespoke tools: `run`,
 * `node_rerun`, `wait_for_settle`, `cancel`, `runs`, `node_cancel`,
 * `lane_cancel`, plus agent-held venue `lease` / `release` (cross-run hold).
 * (`run.cancel` is the surface mutation full-run `cancel` drives; it's not
 * exposed directly — the tool also confirms teardown.)
 *
 * Every bespoke tool takes an optional `checkout` argument (absolute path of
 * the target checkout's root; default this server's own cwd — see
 * packages/cli/src/mcp/checkout.ts), so one server drives runs across MANY checkouts. Two
 * more consequences ride with that design:
 *
 *   - resources are server-published streams and stay bound to the HOME
 *     checkout; per-checkout reads arrive on the verbs (and log files via
 *     `@odu/run-client`'s exported `logPathFor` spelling).
 *   - `run` spawns its coordinator DETACHED and this server reaps nothing on
 *     close: a run outlives the MCP process that launched it, so a harness
 *     restart of `odu mcp` kills no run. (It once called `killRuns()` here —
 *     the exact property the consumer needed removed.) Outliving the HOST is
 *     NOT promised — the coordinator lives and dies with the process that
 *     started it (a service stop kills the whole cgroup), and the corpse is
 *     reported, never hidden: see `@odu/run-client`'s `deadRun`.
 *
 * `node_rerun` / `node_cancel` / `lane_cancel` are bespoke rather than
 * `expose`d: a procedure-exposed tool cannot carry a DESCRIPTION
 * (`ToolExposure` has no field for one) and cannot take a per-call `checkout`
 * (an exposed input is the A-side wire shape). packages/cli/src/mcp/rerunTool.ts carries
 * the whole account for the verb that could least afford a blank description.
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
} from "./mcp/agentSurface";
import {
  dialAFor,
  redialingAClient,
} from "@odu/execution/coordinator/agentReader";
import { cancelTool } from "./mcp/cancelTool";
import { leaseTool, releaseTool } from "./mcp/leaseTool";
import { laneCancelTool, nodeCancelTool } from "./mcp/partialCancelTools";
import { runTool } from "./mcp/runTool";
import { rerunTool } from "./mcp/rerunTool";
import { runsTool } from "./mcp/runsTool";
import { makeWaitTool } from "./mcp/waitTool";
import { gitRunContext } from "@odu/execution/common/git";

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
  // going (see `waitForSettle`'s read loop). What the handler gets is the
  // B-client built below — NOT `agentReaderForSocket`, which is `odu wait`'s;
  // the two faces share this `redialingAClient` (and so the re-dial), the row
  // mapping and the settle core, but not the error channel, and
  // `agentReaderForSocket`'s doc is where that is set out. No socket → the
  // A-client yields the no-run value, so
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
    // THE CORE of a rooted bundle. Upstream composes over `{ core?, surfaces? }`
    // now — a bundle may carry siblings, each keyed by the segment its names
    // take — and odu serves one unprefixed root, so it is all core and no
    // siblings.
    core: {
      surface: projection.surface,
      expose: {
        nodes: "resource",
        logs: "resource",
        // No procedures are exposed: each `node.*` / `lane.*` verb ships as a
        // bespoke tool below — the only door that carries a description AND a
        // per-call `checkout` (see rerunTool.ts / partialCancelTools.ts).
      },
    },
    // The adapter memoizes one connection for reads/tools; the freshness lives
    // a layer down, in the re-dialing A-client, so this can be the bare,
    // already-built B-client (nothing per-call to dispose here). A ROOTED
    // BUNDLE rather than a bare client, for the reason above: odu's whole
    // bundle is its core.
    client: () => ({ core: bClient }),
    tools: {
      run: runTool,
      node_rerun: rerunTool,
      wait_for_settle: makeWaitTool(gitRunContext),
      cancel: cancelTool,
      runs: runsTool,
      node_cancel: nodeCancelTool,
      lane_cancel: laneCancelTool,
      lease: leaseTool,
      release: releaseTool,
    },
    serverInfo: { name: "odu", version: version() },
  });

  // Serve until the client disconnects (the StdioServerTransport closes on
  // stdin EOF) or a signal. The server owns stdin/stdout; we just await the
  // close. Background runs the `run` tool spawned are NOT reaped: a
  // coordinator outlives this server's own EXIT by design (detached spawn —
  // see `coordinatorSpawnSpec` and `spawnSurvival.test.ts`), so a harness
  // restart of `odu mcp` kills no run — but a restart of the host that runs
  // this server kills the run with it (the cgroup answer no spawn flag
  // shields; the corpse is reported via `@odu/run-client`'s `deadRun`).
  // Stopping one is the `cancel` tool while this server lives,
  // or `odu cancel` anytime.
  await new Promise<void>((resolve) => {
    const shutdown = (): void => resolve();
    server.onclose = shutdown;
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  await close();
  return 0;
}
