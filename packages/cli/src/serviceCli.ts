/**
 * `odu surface …` — the service, projected as argv.
 *
 * `@kolu/surface-cli` derives every command from the same surface and the same
 * `expose` map the MCP face reads, so `run_start` is one verb with one name and
 * one input shape in a terminal and to an agent. Nothing here is hand-written
 * per verb; what IS written here is the three things only odu knows: where to
 * dial, what the page says, and how the whole thing is mounted.
 *
 * ## Why it is mounted under a parent of its own
 *
 * `surfaceCommands` claims four subcommand names beside the verbs — `get`,
 * `keys`, `watch`, `list` — and odu's top level already has `logs`, `runs`,
 * `wait` and a dozen more. Mounting the projection at the root would put those
 * four in the same namespace as commands that mean something else here (odu's
 * own `wait` is about a LIVE run in the current checkout; the projection's
 * `get` is about any member of any surface). `odu surface` takes no names from
 * anybody, which is exactly what the framework's own reference recommends.
 *
 * ## The exits are the framework's, and that is the point
 *
 * A caller cannot tell "CI failed" from "odu is not running" by reading text,
 * so the two are different exits — and neither is invented here:
 *
 *   0   the call was answered, INCLUDING an answer that reports red CI
 *   1   odu declared a refusal (one JSON line on stderr)
 *   2   a usage error that never left this process
 *   3   nothing is serving — run `odu web`
 *   130 interrupted; the run carries on
 *
 * `odu wait --run`'s own exits are DIFFERENT and deliberately so: that command
 * answers a question about CI, so it spends its exit codes on CI's answer. This
 * face answers a question about a CALL, so it spends them on the call. Two
 * vocabularies, each internally consistent, and the README says which is which.
 */

import {
  buildSurfaceFace,
  type SurfaceClientCallable,
} from "@kolu/surface/client";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type EndpointSeam,
  type ResolvedEndpoint,
  type SurfaceCliConnection,
  type SurfaceCliHelp,
  reportingRunEdge,
  surfaceCommands,
  surfaceHelp,
} from "@kolu/surface-cli";
import { ODU_VERSION } from "@odu/execution/common/version";
import { dialService } from "@odu/service-client/dial";
import { serviceOrigin } from "@odu/service-client/endpoint";
import { oduServiceSurface } from "@odu/service-client/surface";
import { ODU_SERVICE_EXPOSE } from "@odu/service-client/verbs";
import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";

/** The one flag this face adds. Defaulted from the environment so the common
 *  case is no flag at all, and named `--origin` rather than `--url` because it
 *  is the SERVICE's address, not one endpoint of it: the websocket route and
 *  the MCP route are both derived from it. */
const endpointFlags = {
  origin: Flag.string("origin").pipe(Flag.withDefault(serviceOrigin())),
};

const endpoint: EndpointSeam<typeof endpointFlags> = {
  flags: endpointFlags,
  resolve: (values): Effect.Effect<ResolvedEndpoint> =>
    Effect.succeed({
      // What a FAILED dial reports, which is exactly when there is no
      // connection left to ask. Named beside the thunk that opens it so the
      // resolution order is walked once.
      where: values.origin,
      open: async (): Promise<SurfaceCliConnection> => {
        const connection = await dialService(values.origin);
        return {
          // The degenerate rooted bundle: one unprefixed core, no siblings, so
          // every argv spelling is the bare one.
          client: {
            // Built over the SAME dispatch the typed face is built over. The
            // projection holds its client opaquely — `SurfaceClientCallable`
            // types the leaves as callable — so it wants a differently-typed
            // view of one connection rather than a second connection.
            core: buildSurfaceFace(
              oduServiceSurface,
              connection.dispatch,
            ) as unknown as SurfaceClientCallable,
          },
          // Required, not optional: a CLI dials, does one thing and exits, and
          // the one failure that costs a user something is a socket left open
          // in a shell loop.
          dispose: () => connection.dispose(),
        };
      },
    }),
};

/**
 * How `odu surface` describes itself.
 *
 * Grouped by WHAT A CALLER IS DOING rather than by member kind, because the
 * loop this face exists to serve is a sequence — start, wait, diagnose, retry —
 * and a page sorted by "tools then resources" would scatter it.
 */
const help: SurfaceCliHelp = {
  command: "surface",
  purpose:
    "Drive every registered odu run — start, wait, diagnose, retry, cancel — " +
    "through the same typed service the browser and the MCP face use.",
  groups: [
    { title: "The loop", verbs: ["run_start", "run_wait", "log_read", "run_retry"] },
    { title: "Stopping work", verbs: ["run_cancel"] },
    { title: "Reading state", verbs: ["get", "keys", "watch", "list"] },
  ],
  examples: {
    run_start:
      `run_start --input '{"checkout":"/code/app","expectedSha":"$SHA","requestId":"start-1"}' --json`,
    run_wait: `run_wait --input '{"runId":"$RUN","after":"$CURSOR"}' --json`,
    log_read: `log_read --input '{"key":"$LOG_KEY","offset":-4096}' --json`,
    run_retry:
      `run_retry --input '{"runId":"$RUN","selector":"ci::unit","requestId":"retry-1"}' --json`,
    run_cancel:
      `run_cancel --input '{"runId":"$RUN","scope":{"kind":"run"},"requestId":"cancel-1"}' --json`,
    get: "get runs $RUN",
    keys: "keys runs",
    watch: "watch runs",
  },
  flags: [
    {
      spelling: "--origin URL",
      description:
        "the service to dial (default http://127.0.0.1:18440, or $ODU_WEB_ORIGIN)",
    },
  ],
  answer:
    "Exit 0 is a call that was answered — including an answer that reports red " +
    "CI or a deadline. Exit 1 is a refusal odu declared. Exit 3 is nothing " +
    "serving: run `odu web`.",
};

const projection = {
  core: { surface: oduServiceSurface, expose: ODU_SERVICE_EXPOSE },
  endpoint,
  help,
  info: { name: "odu" },
} as const;

/** The `odu surface` command tree. */
function oduSurfaceFace() {
  return Command.make("surface").pipe(
    Command.withDescription(surfaceHelp(projection)),
    Command.withSubcommands(surfaceCommands(projection)),
  );
}

/**
 * Run the projection, and never come back.
 *
 * The Effect CLI runtime owns the process edge for this face — it writes the
 * failure's own line, maps the verdict to an exit code, and exits — which is
 * why this returns a promise that never settles rather than a code for odu's
 * own `exitAfterFlush`. Two owners of one exit is one too many, and the
 * framework's is the one that knows which of the five codes above applies.
 *
 * `reportingRunEdge` is not garnish: every failure this face raises carries
 * `errorReported = false` (its line is its own, and Effect's pretty cause dump
 * on top would land on STDOUT, in the middle of the data), so a host that
 * re-failed without writing that line would exit with the right code and say
 * NOTHING. `disableErrorReporting` is the other half — without it the runtime
 * prints a second, differently-worded report of the same failure.
 */
export function surfaceCliMain(argv: readonly string[]): Promise<number> {
  NodeRuntime.runMain(
    Command.runWith(oduSurfaceFace(), { version: ODU_VERSION })(argv).pipe(
      reportingRunEdge,
      Effect.provide(NodeServices.layer),
    ),
    { disableErrorReporting: true },
  );
  return new Promise<number>(() => {});
}
