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
import { serviceOrigin } from "@odu/service-client/endpoint";
import { composedClients } from "@odu/cordis/compose";
import {
  connectOrStartSingleton,
  EVERY_ROW_NEEDS,
  SERVICE_SIBLINGS,
  SIBLING_ROWS,
} from "./wire";
import { oduServiceSurface } from "@odu/service-client/surface";
import { ODU_SERVICE_EXPOSE } from "@odu/service-client/verbs";
import { Effect } from "effect";
import { Command, Flag } from "effect/cli";

const endpointFlags = {
  origin: Flag.String("origin").pipe(Flag.withDefault(serviceOrigin())),
};

const endpoint: EndpointSeam<typeof endpointFlags> = {
  flags: endpointFlags,
  resolve: (values): Effect.Effect<ResolvedEndpoint> =>
    Effect.succeed({
      where: values.origin,
      open: async (): Promise<SurfaceCliConnection> => {
        const connection = await connectOrStartSingleton(values.origin, {
          needs: EVERY_ROW_NEEDS,
        });
        return {
          client: {
            core: buildSurfaceFace(
              oduServiceSurface,
              connection.dispatch,
            ) as unknown as SurfaceClientCallable,
            clients: composedClients(SERVICE_SIBLINGS, connection.dispatch),
          },
          dispose: () => connection.dispose(),
        };
      },
    }),
};

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
    log_read: `log_read --input '{"key":"$LOG_KEY","offset":-4096,"stream":"push"}' --json`,
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
    "serving — which at the default origin means odu tried to start the " +
    "service and could not, and says why.",
};

const projectedSiblings = Object.fromEntries(
  SIBLING_ROWS.flatMap((row) => (row.key === null ? [] : [[row.key, row.agent] as const])),
);

const projection = {
  core: { surface: oduServiceSurface, expose: ODU_SERVICE_EXPOSE },
  surfaces: projectedSiblings,
  endpoint,
  help,
  info: { name: "odu" },
} as const;

function oduSurfaceFace() {
  return Command.make("surface").pipe(
    Command.withDescription(surfaceHelp(projection)),
    Command.withSubcommands(surfaceCommands(projection)),
  );
}

/**
 * The Effect CLI runtime owns the process edge for this face — it writes the
 * failure's own line, maps the verdict to an exit code, and exits — which is
 * why this returns a promise that never settles rather than a code for odu's
 * own `exitAfterFlush`.
 *
 * Every failure this face raises carries `errorReported = false`, so a host
 * that re-failed without writing that line would exit with the right code and
 * say NOTHING. `disableErrorReporting` is the other half — without it the
 * runtime prints a second, differently-worded report of the same failure.
 */
export function surfaceCliMain(argv: readonly string[]): Promise<never> {
  NodeRuntime.runMain(
    Command.runWith(oduSurfaceFace(), { version: ODU_VERSION })(argv).pipe(
      reportingRunEdge,
      Effect.provide(NodeServices.layer),
    ),
    { disableErrorReporting: true },
  );
  return new Promise<never>(() => {});
}
