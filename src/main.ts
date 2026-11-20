import { ciCommand, CI_USAGE } from "@odu/cli/ciCli";
import { cacheCommand } from "@odu/cache/cli";
import { CACHE_NEEDS } from "@odu/cache/surface";
import { internalCommand } from "@odu/cli/internalCli";
import { serviceMcpCommand } from "@odu/cli/serviceMcp";
import { ODU_VERSION } from "@odu/execution/common/version";
import { surfaceCliMain } from "@odu/cli/serviceCli";
import { webCommand, webDaemonCommand } from "@odu/host/web";
import { connectOrStartSingleton, EVERY_ROW_NEEDS } from "@odu/cli/wire";
import { authCommand } from "@odu/auth/cli";
import { errorMessage, errorStack } from "@odu/execution/common/effectEdge";
import { parseArgs } from "node:util";

const USAGE = `usage: odu <ci|cache|auth|web|surface|mcp> [args]

The board and the API are the product. What stays here is what has to run in a
shell: a run in THIS checkout, a push from the machine that holds the paths,
the credentials those read, and the service itself. Administration — buckets,
tokens, domains, pins, GC, people, roles, the tunnel — is a control on the
board, or \`odu surface <row> <verb>\` for a terminal and \`odu mcp\` for an agent.

ci <run|wait|rerun|cancel|logs|history|status|attach|hosts|lease|release|dump|graph|protect>
                              # the runs: start one in this checkout, watch it,
                              # read a log, retry, cancel (odu ci --help)
cache <use|login|push|target> # a bucket's nix.conf and netrc lines, this
                              # machine's token for a cache, and a push from
                              # HERE (odu cache --help). Buckets, tokens, pins
                              # and GC are the board, or \`odu surface cache …\`
auth login <origin>           # save this machine's token for a server
                              # (odu auth --help). People, roles, sessions and
                              # personal tokens are the board, or
                              # \`odu surface auth …\`
web [--background] [--upgrade] [-o json]
                              # the service. Bare: serves in this terminal
                              # until Ctrl-C (runs you start keep going).
                              # --background: ensure one that outlives this
                              # shell. --upgrade drains a running other build
surface <verb> [--input JSON] [--json]
                              # the service as argv: run_start, run_wait,
                              # run_read, run_list, run_retry, run_cancel,
                              # log_read, catalog_*, pipeline_read, venue_*,
                              # protect_apply, and every sibling row's verbs
                              # under its own word (\`odu surface cache
                              # bucket_create\`, \`odu surface auth user_grant\`,
                              # \`odu surface cloudflare status_read\`), plus
                              # get/keys/watch/list. odu surface --help lists them.
                              # Exits: 0 answered (red CI included) · 1
                              # refused · 2 usage · 3 nothing serving · 130 interrupted
mcp                           # the service as MCP over stdio — the same verbs,
                              # the same names, no run authority of its own.
                              # Starts the service if none is running.

--origin URL is accepted by every service client (default $ODU_WEB_ORIGIN or
http://127.0.0.1:18440). A named origin is dialled and only dialled: odu starts
a service for you only when you meant the default one.
`;

async function dispatch(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const internal = internalCommand(command, rest);
  if (internal !== null) return internal;
  switch (command) {
    case "ci": {
      const [sub, ...subRest] = rest;
      return ciCommand(sub, subRest);
    }
    case "cache": {
      const [sub, ...subRest] = rest;
      return cacheCommand(sub, subRest, {
        connect: async (origin) => {
          const connection = await connectOrStartSingleton(origin, { needs: CACHE_NEEDS });
          return {
            dispatch: connection.dispatch,
            dispose: async () => {
              await connection[Symbol.asyncDispose]();
            },
          };
        },
      });
    }
    case "auth": {
      const [sub, ...subRest] = rest;
      return authCommand(sub, subRest);
    }
    case "web": {
      const { values } = parseArgs({
        args: rest,
        options: {
          upgrade: { type: "boolean" },
          background: { type: "boolean" },
          output: { type: "string", short: "o" },
        },
      });
      return webCommand({
        upgrade: values.upgrade ?? false,
        background: values.background ?? false,
        json: values.output === "json",
        needs: EVERY_ROW_NEEDS,
      });
    }
    case "web-daemon":
      return webDaemonCommand();
    case "surface":
      return surfaceCliMain(rest);
    case "mcp": {
      const { values } = parseArgs({
        args: rest,
        options: {
          service: { type: "boolean" },
          origin: { type: "string" },
        },
      });
      if (values.service === true) {
        process.stderr.write(
          "odu: `odu mcp --service` is now the only behaviour — drop the flag " +
            "(it is accepted for one release and then removed)\n",
        );
      }
      return serviceMcpCommand({
        version: ODU_VERSION,
        ...(values.origin === undefined ? {} : { origin: values.origin }),
      });
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return command === undefined ? 1 : 0;
    default:
      process.stderr.write(`odu: unknown command "${command}"\n${USAGE}`);
      return 1;
  }
}

const FLUSH_BOUND_MS = 30_000;

/**
 * `process.exit` does not flush a pipe.
 * Under the Bun runtime the binary ships on, a single large
 * write reports `writableLength` 0 and `write("")` true while the bytes are
 * still queued, so the loop exited at once and a pipe got a prefix of it.
 */
async function exitAfterFlush(code: number): Promise<never> {
  await new Promise<void>((resolve) => {
    process.stdout.once("finish", () => resolve());
    process.stdout.once("error", () => resolve());
    setTimeout(resolve, FLUSH_BOUND_MS).unref();
    process.stdout.end();
  });
  process.exit(code);
}

dispatch(process.argv.slice(2)).then(
  (code) => exitAfterFlush(code),
  (err: unknown) => {
    process.stderr.write(`${errorMessage(err)}\n`);
    if (process.env.ODU_DEBUG !== undefined && process.env.ODU_DEBUG !== "") {
      process.stderr.write(`${errorStack(err)}\n`);
    }
    return exitAfterFlush(1);
  },
);
