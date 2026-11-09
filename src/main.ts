/**
 * odu — a CI runner you attach to, and a Nix cache you run yourself. ஓடு: run.
 *
 * ONE SUPPORTED RUNTIME, ONE PUBLIC VOCABULARY, THREE FACES.
 *
 * odu runs only from its Nix package: the wrapper bakes odu's own path, the
 * browser bundle, this build's identity and the osfacts binary, and a build
 * missing any of them REFUSES rather than repairing itself into a subtly
 * different application. `nix run github:juspay/odu -- …`, or `nix run . -- …`
 * in a checkout.
 *
 * ONE WORD PER ROW, AND NOTHING ELSE AT THE ROOT.
 *
 * `odu` names rows (`ci`, `cache`, `auth`) and the service itself (`web`,
 * `surface`, `mcp`); a row's verbs are the row's own business, dispatched by
 * the row's own argv face. The runs used to be spelled at the top level, from
 * the days when a run was the only thing odu did, which left one row holding
 * fifteen root words while the cache held one.
 *
 * WHAT IS LEFT HERE IS WHAT NEEDS A SHELL. The web face and the web API are
 * the product: a verb that exists only in the CLI is a defect, and every
 * administrative verb — buckets, tokens, domains, pins, GC, people, roles,
 * sessions, the tunnel — is now a control on the board and a verb on the API
 * (`odu surface <row> <verb>`, the same names `odu mcp` serves to an agent).
 * The CLI keeps what has to run on the machine that holds the paths or the
 * checkout: a run in this checkout, a push, the credentials a push and a
 * remote client read, and the service itself.
 *
 *   odu ci <run|wait|rerun|…>   the runs (@odu/cli/ciCli)
 *   odu cache <use|login|push|target>
 *                             the cache's shell-native verbs (@odu/cache/cli)
 *   odu auth login              this machine's token for a server (@odu/auth/cli)
 *   odu web [--background]      the service itself
 *   odu surface <verb>          the service, projected as argv
 *   odu mcp                     the service, projected as MCP
 *
 * EVERY public command is a CLIENT of the singleton `odu web` daemon, which
 * owns execution, retry policy, the run catalog, the venue inventory, pipeline
 * resolution and every coordinator dial. The faces contribute argument grammar,
 * rendering and exit codes, and nothing else. They bootstrap the service if
 * none is running, and they never fall back to doing the work locally: a second
 * authority is exactly what this arrangement exists to remove.
 *
 * "Every" is meant literally, and it is checked. `packages/cli/src/
 * authority.test.ts` DERIVES the set it polices from this file's own imports
 * and walks their closure, so a command cannot be exempted by forgetting to
 * list it — which is how nine of them came to hold local authority under a
 * green test.
 */

import { ciCommand, CI_USAGE } from "@odu/cli/ciCli";
import { cacheCommand } from "@odu/cache/cli";
import { CACHE_NEEDS } from "@odu/cache/surface";
import { internalCommand } from "@odu/cli/internalCli";
import { serviceMcpCommand } from "@odu/cli/serviceMcp";
import { ODU_VERSION } from "@odu/execution/common/version";
import { surfaceCliMain } from "@odu/cli/serviceCli";
import { webCommand, webDaemonCommand } from "@odu/host/web";
import { connectToService, EVERY_ROW_NEEDS } from "@odu/cli/wire";
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
  // THE WORKERS FIRST, and out of this file entirely — `run-coordinator` and
  // `lease-hold` are argv entry points a launcher types, never a person, and
  // they are the only two things in odu that legitimately reach the engine.
  //
  // `run-coordinator` IS the coordinator, and it is deliberately absent from
  // USAGE, like `web-daemon` and `lease-hold`. A person types `odu ci run`,
  // which is a thin client of the service; a LAUNCHER
  // (`packages/execution/src/coordinator/launcher.ts`) types this, with argv it
  // builds itself. The split is not tidiness: while both were spelled `run`,
  // making the public verb a service client would have meant `run.start →
  // packagedLauncher → odu run → run.start`, forever. Its four identity flags
  // live there and nowhere else — `--run-id` in particular lets its caller mint
  // a run identity the catalog will accept, which is authority no public
  // command should have.
  //
  // Keeping their dispatch bodies here would put `@odu/execution/coordinator`
  // in this module's import list, which is the list `./packages/cli/src/
  // authority.test.ts` derives the public-client set FROM. See `internalCli`.
  const internal = internalCommand(command, rest);
  if (internal !== null) return internal;
  switch (command) {
    // THE RUNS' ROW. Its verbs, its grammar and its usage text are
    // `@odu/cli/ciCli`'s — this package is the `ci` row's face, the same way
    // `@odu/cache/cli` is the cache's.
    case "ci": {
      const [sub, ...subRest] = rest;
      return ciCommand(sub, subRest);
    }
    case "cache": {
      const [sub, ...subRest] = rest;
      // THE ONE PORT this face takes: the way to the daemon. The bootstrap is
      // `@odu/launch`'s — starting a service is not a row's business — so the
      // root binds it, and `@odu/cache/cli` stays a client that names no host.
      return cacheCommand(sub, subRest, {
        connect: (origin) => connectToService(origin, { needs: CACHE_NEEDS }),
      });
    }
    case "auth": {
      const [sub, ...subRest] = rest;
      // One verb wide: `odu auth login` writes the credential every other
      // command reads (`@odu/cli/wire`). It takes no port — it dials nothing —
      // and the rest of the door's vocabulary is the board's and the API's.
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
        // The board reads every row the daemon mounts — the same set the
        // composed faces declare, from the one place it is spelled.
        needs: EVERY_ROW_NEEDS,
      });
    }
    // The daemon `odu web --background` spawns. Deliberately absent from USAGE:
    // a person who wants to watch a server runs `odu web`, which serves in the
    // foreground and says so. This one is quiet, yields silently to a live
    // holder, and ends only through the control fragment's `drain` — which is
    // what a supervisor wants and what a person almost never does.
    case "web-daemon":
      return webDaemonCommand();
    // The generated face owns its own process edge (the Effect CLI runtime
    // writes the failure's line and exits with the verdict), so this never
    // returns — see `surfaceCliMain`.
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
      // ONE SUBJECT: every registered run, through the singleton service. There
      // used to be two faces here — a default that held its own run authority
      // over this checkout's `.ci/odu.sock` and nine tools of its own, and
      // `--service` for the shared one. Two faces meant two answers to "what
      // did I just do to this run", visible only when an agent and a person
      // disagreed about it, so the per-checkout face is gone and this is the
      // face.
      //
      // `--service` is still PARSED, and deliberately: it is the spelling in
      // consumers' `.mcp.json` files today, and `parseArgs` would throw on an
      // unknown option — an MCP host would see an unparseable startup crash
      // rather than a sentence. It is accepted, ignored, and named on stderr
      // (never stdout, which is the JSON-RPC pipe).
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
      // A CI VERB TYPED BARE lands here, and the usage text above names the
      // word it now lives under. There is no alias: two spellings of one verb
      // is the drift this release removes, and `odu ci --help` is one line
      // away.
      process.stderr.write(`odu: unknown command "${command}"\n${USAGE}`);
      return 1;
  }
}

/** How long an exit waits for stdout to drain before giving up on the reader.
 *  Generous: a slow agent draining megabytes of log is the ordinary case. */
const FLUSH_BOUND_MS = 30_000;

/**
 * Exit, but not before what we printed has actually left the process.
 *
 * `process.exit` does not flush a pipe. Writing to a TERMINAL is synchronous,
 * so this never mattered while every command's output was a few lines and a
 * developer was watching it — but `odu ci logs` hands back a whole node's log,
 * and a recipe that emits fourteen megabytes hands back fourteen megabytes.
 * Piped to a file or read by an agent, that write is asynchronous and queued,
 * and exiting on the next tick truncates it: the reader gets a prefix,
 * mid-line, with nothing to say it is a prefix. Measured, not theorised — the
 * e2e suite caught it as `JSON Parse error: Unterminated string` on the noisy
 * fixture's log.
 *
 * **Ending the stream is the only signal that holds under Bun.** This used to
 * be the drain protocol — `write("")` false while above the high-water mark,
 * then `drain` — and under the Bun runtime the binary ships on, a single large
 * write reports `writableLength` 0 and `write("")` true while the bytes are
 * still queued, so the loop exited at once and a pipe got a prefix of it.
 * `odu ci history list --all -o json` on a thousand-run catalog was a third of
 * an array (juspay/odu#113's scale e2e caught it). `end()` then `finish` waits
 * for what was actually written, on a pipe, a file and a terminal alike; a
 * reader that went away raises `error` instead, which ends the wait too. And
 * the wait is BOUNDED, because an exit that never happens is worse than an
 * output that is short: a stream already destroyed by an earlier EPIPE emits
 * neither event, and neither might an fd type this runtime treats oddly.
 */
async function exitAfterFlush(code: number): Promise<never> {
  await new Promise<void>((resolve) => {
    process.stdout.once("finish", () => resolve());
    process.stdout.once("error", () => resolve());
    // Unref'd: the bound must never be the thing keeping the process alive.
    setTimeout(resolve, FLUSH_BOUND_MS).unref();
    process.stdout.end();
  });
  process.exit(code);
}

dispatch(process.argv.slice(2)).then(
  (code) => exitAfterFlush(code),
  (err: unknown) => {
    // The MESSAGE for a person, the stack under `$ODU_DEBUG` for whoever has to
    // find out why. A failure that reaches here is by definition one nothing
    // planned for, and some of them arrive with a message that names no cause
    // at all — "All fibers interrupted without error" is a sentence about this
    // process's runtime, not about anything a user did.
    process.stderr.write(`${errorMessage(err)}\n`);
    if (process.env.ODU_DEBUG !== undefined && process.env.ODU_DEBUG !== "") {
      process.stderr.write(`${errorStack(err)}\n`);
    }
    return exitAfterFlush(1);
  },
);
