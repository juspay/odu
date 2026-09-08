/**
 * odu — a CI runner you attach to. ஓடு: run.
 *
 * ONE SUPPORTED RUNTIME, ONE PUBLIC VOCABULARY, THREE FACES.
 *
 * odu runs only from its Nix package: the wrapper bakes odu's own path, the
 * browser bundle, this build's identity and the osfacts binary, and a build
 * missing any of them REFUSES rather than repairing itself into a subtly
 * different application. `nix run github:juspay/odu -- …`, or `nix run . -- …`
 * in a checkout.
 *
 * EVERY public command below is a CLIENT of one shared service — the singleton
 * `odu web` daemon, which owns execution, retry policy, the run catalog, the
 * venue inventory, pipeline resolution and every coordinator dial. The commands
 * here contribute argument grammar, rendering and exit codes, and nothing else.
 * They bootstrap the service if none is running, and they never fall back to
 * doing the work locally: a second authority is exactly what this arrangement
 * exists to remove.
 *
 * "Every" is meant literally, and it is checked. `packages/cli/src/
 * authority.test.ts` DERIVES the set it polices from this file's own imports,
 * so a command cannot be exempted by forgetting to list it — which is how nine
 * of them came to hold local authority under a green test. The three that used
 * to look like safe exceptions are gone: reading a justfile locally was a
 * second resolver of what odu will run, and "protect spends YOUR credential,
 * not the daemon's" described an odu that does not exist, since the coordinator
 * the daemon launches has posted commit statuses with it all along.
 *
 *   odu run [recipe[@platform]…]           start a run here, then watch it
 *                                          (Ctrl-C stops WATCHING, not the run)
 *   odu wait [--run R]                     bounded, resumable attention
 *   odu rerun [--run R] <selector>         retry; odu decides live vs replay
 *   odu cancel [--run R] [node|@platform]  stop a run, a node, or a lane
 *   odu logs <log-key> [-f]                one attempt's bytes, by its key
 *   odu history <list|show|import|prune>   the per-user run catalog
 *   odu status / attach                    this checkout's newest live run
 *   odu hosts / lease / release            venue inventory and holds
 *   odu dump / graph                       the resolved pipeline
 *   odu protect                            required status checks
 *   odu web [--background] [--upgrade]     the service itself
 *   odu surface <verb>                     the service, projected as argv
 *   odu mcp                                the service, projected as MCP
 *
 * Runs are addressed GLOBALLY, by run id, so `wait`, `rerun` and `cancel`
 * take `--run` and work from any directory about any run — `odu history list`
 * is where you find an id. Omitting it means `latest`: the newest run of THIS
 * checkout, which is what these three have always meant when typed bare and is
 * a default rather than a second addressing scheme.
 *
 * Strict by default: refuses a dirty tree, pins HEAD via `git worktree`,
 * posts commit statuses under `<recipe>@<platform>` contexts, splits logs
 * into `.ci/<sha>/<platform>/<recipe>.log`. Opt-outs: `--no-post` (strict,
 * no GitHub writes), `--no-snapshot` (live tree, implies --no-post),
 * `--no-strict` (≡ both — the dev-iteration one-flag opt-out).
 */

import { parseArgs } from "node:util";
import {
  cancelViaService,
  importViaService,
  listViaService,
  logsViaService,
  pruneViaService,
  retryViaService,
  runViaService,
  showViaService,
  waitViaService,
} from "@odu/cli/serviceCommands";
import { attachViaService, statusViaService } from "@odu/cli/serviceStatus";
import {
  hostsViaService,
  leaseViaService,
  releaseViaService,
} from "@odu/cli/serviceVenue";
import {
  pipelineViaService,
  protectViaService,
} from "@odu/cli/servicePipeline";
import { internalCommand } from "@odu/cli/internalCli";
import { serviceMcpCommand } from "@odu/cli/serviceMcp";
import { ODU_VERSION } from "@odu/execution/common/version";
import { surfaceCliMain } from "@odu/cli/serviceCli";
import { webCommand, webDaemonCommand } from "@odu/cli/web";

const USAGE = `usage: odu <run|wait|rerun|cancel|logs|history|status|attach|hosts|lease|release|dump|graph|protect|web|surface|mcp> [args]

Every command below is a client of the shared odu service. It is started for you
if none is running; nothing here runs CI by itself.

run [recipe[@platform]…] [--platform P]… [--host P=ADDR]… [--root NAMEPATH]
    [--no-deps] [--no-strict] [--no-snapshot] [--no-post] [--supersede]
    [--no-wait] [--request-id ID] [--progress json] [-o json]
                              # start a run in THIS checkout and watch it.
                              # Ctrl-C stops watching; the run keeps going.
wait [--run R] [--after CURSOR] [--deadline-ms N] [--settle] [-o json]
                              # bounded, resumable. Returns on the first red
                              # you can act on, not on settle. Exits: 0 passed
                              # 1 a failure to act on · 2 still going, nothing
                              # red · 3 owner lost · 4 no such run · 5 refused
                              # --run omitted = latest: this checkout's newest
rerun [--run R] [--request-id ID] [--expect-attempt N] [-o json] <selector>
                              # a new attempt if its coordinator is still up,
                              # else a new linked run. odu decides, and says so.
                              # --expect-attempt guards one node against having
                              # moved on, so the selector must be a full node id
cancel [--run R] [node|@platform] [--request-id ID] [-o json]
                              # bare = whole run; node or @plat = partial
logs <log-key> [-f] [--offset B] [--limit B] [--wait-ms N] [-o json]
                              # ECHO the logKey a failure reported. --offset
                              # counts from the start; a NEGATIVE one is a tail
                              # and must be joined: --offset=-4096.
                              # -f follows to the end: exits 0 with the whole
                              # log, 1 if it was truncated
history <list|show|import|prune>
                              # the per-user run catalog (odu history --help)
status [-o json]              # this checkout's newest unfinished run: its
                              # nodes, its lanes, and what it still owes GitHub
attach [-o json]              # the same run, followed until it stops moving
hosts [PLAT…] [-o json]       # every configured venue, and who holds it.
                              # Naming platforms skips dialling the rest
lease [PLAT…] [--no-wait] [-o json]
                              # hold a venue across runs. The holder is the
                              # SERVICE's child, so it outlives this shell
release [PLAT…] [-o json]     drop held lease(s)
dump [--root NAMEPATH]        # the resolved pipeline, as JSON
graph [--root NAMEPATH]       # the same DAG, as Mermaid
protect [--dry-run] [--branch B] [--platform P]… [--create] [-o json]
                              # require exactly the checks odu posts. --create
                              # makes the branch's ruleset if absent
web [--background] [--upgrade] [-o json]
                              # the service. Bare: serves in this terminal
                              # until Ctrl-C (runs you start keep going).
                              # --background: ensure one that outlives this
                              # shell. --upgrade drains a running other build
surface <verb> [--input JSON] [--json]
                              # the service as argv: run_start, run_wait,
                              # run_read, run_retry, run_cancel, log_read,
                              # catalog_*, pipeline_read, venue_*,
                              # protect_apply, and get/keys/watch/list. odu
                              # surface --help lists them.
                              # Exits: 0 answered (red CI included) · 1
                              # refused · 2 usage · 3 nothing serving · 130 interrupted
mcp                           # the service as MCP over stdio — the same verbs,
                              # the same names, no run authority of its own.
                              # Starts the service if none is running.

--origin URL is accepted by every service client (default $ODU_WEB_ORIGIN or
http://127.0.0.1:18440). A named origin is dialled and only dialled: odu starts
a service for you only when you meant the default one.
`;

/** A flag's integer value, or a usage error naming the flag.
 *
 *  `Number("")` is 0 and `Number(" 5 ")` is 5, so a bare `Number` would read a
 *  truncated `--offset=` as "from the beginning" and a typo as a value. A
 *  digits-only parse refuses what the flag cannot have meant. */
function integer(flag: string, raw: string): number {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`odu: ${flag} needs a whole number (got "${raw}")`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`odu: ${flag} is out of range (got "${raw}")`);
  }
  return value;
}

function positiveInt(flag: string, raw: string): number {
  const value = integer(flag, raw);
  if (value <= 0) {
    throw new Error(`odu: ${flag} needs a positive number (got "${raw}")`);
  }
  return value;
}

const HISTORY_USAGE = `usage: odu history <list|show|import|prune> [args]

list [--all] [--limit N] [-o json]   runs in the per-user catalog, newest first
show [--run R] [--after CURSOR] [-o json]
                                     one run's attention payload, without waiting
import [--dry-run] [-o json]         bring this checkout's .ci records in
prune [--days N] [--dry-run] [-o json]
                                     expire finished runs past the window (30d)
`;

/** `odu history` — the per-user catalog's own commands. A sub-command group
 *  rather than five top-level verbs: these are all about the CATALOG, and the
 *  top level is about a RUN. */
async function historyCommand(
  sub: string | undefined,
  rest: string[],
): Promise<number> {
  switch (sub) {
    case "list": {
      const { values } = parseArgs({
        args: rest,
        options: {
          all: { type: "boolean" },
          limit: { type: "string" },
          origin: { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      // The BOARD, filtered to this checkout unless `--all`. It reads the
      // service's `runs` collection rather than walking the catalog: the
      // catalog is the service's to read, and a second reader is a second
      // answer to "what runs do I have".
      return listViaService({
        json: values.output === "json",
        all: values.all ?? false,
        ...(values.origin === undefined ? {} : { origin: values.origin }),
        ...(values.limit === undefined
          ? {}
          : { limit: positiveInt("--limit", values.limit) }),
      });
    }
    case "show": {
      const { values } = parseArgs({
        args: rest,
        options: {
          run: { type: "string" },
          after: { type: "string" },
          origin: { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      return showViaService({
        run: values.run ?? HERE_AND_NOW,
        ...(values.after === undefined ? {} : { after: values.after }),
        ...(values.origin === undefined ? {} : { origin: values.origin }),
        json: values.output === "json",
      });
    }
    case "import": {
      const { values } = parseArgs({
        args: rest,
        options: {
          "dry-run": { type: "boolean" },
          origin: { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      return importViaService({
        json: values.output === "json",
        dryRun: values["dry-run"] ?? false,
        ...(values.origin === undefined ? {} : { origin: values.origin }),
      });
    }
    case "prune": {
      const { values } = parseArgs({
        args: rest,
        options: {
          days: { type: "string" },
          "dry-run": { type: "boolean" },
          origin: { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      return pruneViaService({
        json: values.output === "json",
        dryRun: values["dry-run"] ?? false,
        ...(values.origin === undefined ? {} : { origin: values.origin }),
        ...(values.days === undefined
          ? {}
          : { retentionDays: positiveInt("--days", values.days) }),
      });
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HISTORY_USAGE);
      return sub === undefined ? 1 : 0;
    default:
      process.stderr.write(
        `odu: unknown history sub-command "${sub}"\n${HISTORY_USAGE}`,
      );
      return 1;
  }
}

/**
 * THE RUN A BARE COMMAND IS ABOUT.
 *
 * `odu wait`, `odu rerun` and `odu cancel` took no run at all before runs
 * became globally addressed: they meant the one in this checkout, which is
 * what somebody standing in a repository means when they type `odu cancel`.
 * Making `--run` mandatory turned that gesture into a usage error.
 *
 * `latest` is that gesture, spelled in the new grammar — the newest run OF
 * THIS CHECKOUT (see `resolveRunAddress`). A run id is still accepted, and now
 * so is another checkout's, which is the capability the addressing bought.
 */
const HERE_AND_NOW = "latest";

async function dispatch(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  // THE WORKERS FIRST, and out of this file entirely — `run-coordinator` and
  // `lease-hold` are argv entry points a launcher types, never a person, and
  // they are the only two things in odu that legitimately reach the engine.
  // Keeping their dispatch bodies here would put `@odu/execution/coordinator`
  // in this module's import list, which is the list `./packages/cli/src/
  // authority.test.ts` derives the public-client set FROM. See `internalCli`.
  const internal = internalCommand(command, rest);
  if (internal !== null) return internal;
  switch (command) {
    // THE COORDINATOR ITSELF — internal execution machinery, and the ONLY
    // caller of `runCommand`.
    //
    // Deliberately absent from USAGE, like `web-daemon` and `lease-hold`. A
    // person types `odu run`, which is a thin client of the service; a LAUNCHER
    // (`packages/execution/src/coordinator/launcher.ts`) types this, with argv
    // it builds itself. The split is not tidiness: while both were spelled
    // `run`, making the public verb a service client would have meant
    // `run.start → packagedLauncher → odu run → run.start`, forever.
    //
    // The four identity flags live here and nowhere else. They are argv rather
    // than an env-var side channel because a recovery has to be showable —
    // "here is exactly what would run" is a list a person can read and re-issue,
    // and never a string anything evals — but `--run-id` in particular lets its
    // caller mint a run identity the catalog will accept, which is authority no
    // public command should have.
    /**
     * `odu run` — start a run through the service, then watch it.
     *
     * It no longer runs CI. `run.start` is the whole of the mutation; what
     * follows is observation, and Ctrl-C ends the observation rather than the
     * run. There is deliberately NO local-execution branch when the daemon is
     * unreachable: `connectOrStart` starts one, and a face that could fall back
     * to running the pipeline itself would be the second authority this whole
     * consolidation exists to remove — reappearing exactly where it is least
     * visible, at the moment the shared service is unreachable.
     */
    case "run": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          platform: { type: "string", multiple: true },
          host: { type: "string", multiple: true },
          root: { type: "string" },
          "no-deps": { type: "boolean" },
          "no-strict": { type: "boolean" },
          "no-snapshot": { type: "boolean" },
          "no-post": { type: "boolean" },
          supersede: { type: "boolean" },
          linger: { type: "boolean" },
          "no-wait": { type: "boolean" },
          "request-id": { type: "string" },
          progress: { type: "string" },
          origin: { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      // `--progress json` is a FROZEN contract that `/do` and kolu's CI parse.
      // It was the coordinator's flag while `odu run` WAS the coordinator, and
      // when this verb became a client it went to `run-coordinator` and nothing
      // put it back — so every caller passing it got `parseArgs` throwing on an
      // unknown option and an immediate exit 1. Same spelling, same events, now
      // read off the service's own node stream.
      if (values.progress !== undefined && values.progress !== "json") {
        throw new Error(`odu: unknown --progress format "${values.progress}"`);
      }
      return runViaService({
        selectors: positionals,
        platforms: values.platform ?? [],
        hostPins: values.host ?? [],
        ...(values.root === undefined ? {} : { root: values.root }),
        noDeps: values["no-deps"] ?? false,
        noStrict: values["no-strict"] ?? false,
        noSnapshot: values["no-snapshot"] ?? false,
        noPost: values["no-post"] ?? false,
        supersede: values.supersede ?? false,
        linger: values.linger ?? false,
        noWait: values["no-wait"] ?? false,
        ...(values.progress === "json" ? { progressJson: true } : {}),
        ...(values["request-id"] === undefined
          ? {}
          : { requestId: values["request-id"] }),
        ...(values.origin === undefined ? {} : { origin: values.origin }),
        json: values.output === "json",
      });
    }
    case "status": {
      const { values } = parseArgs({
        args: rest,
        options: {
          origin: { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      return statusViaService({
        ...(values.origin === undefined ? {} : { origin: values.origin }),
        json: values.output === "json",
      });
    }
    /**
     * `odu logs <key>` — one attempt's bytes, addressed by the key a failure
     * handed you.
     *
     * The addressing changed with the authority. It used to take a NODE id and
     * mean "in this checkout's live run" — which is only nameable if the face
     * is allowed to dial that checkout's socket. A log key is host-global and
     * self-contained, so this command works from anywhere, about any run, and
     * an agent echoes the key `run_wait` gave it rather than reassembling a run,
     * a node and an attempt into an address.
     */
    case "logs": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          offset: { type: "string" },
          limit: { type: "string" },
          follow: { type: "boolean", short: "f" },
          "wait-ms": { type: "string" },
          origin: { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      const key = positionals[0];
      if (key === undefined) {
        throw new Error(
          "odu: logs needs a log key — the `logKey` a failure reported " +
            "(odu wait --run R, or run_wait). Echo it; do not build one.",
        );
      }
      return logsViaService({
        key,
        ...(values.offset === undefined
          ? {}
          : { offset: integer("--offset", values.offset) }),
        ...(values.limit === undefined
          ? {}
          : { limit: positiveInt("--limit", values.limit) }),
        ...(values.follow === true ? { follow: true } : {}),
        ...(values["wait-ms"] === undefined
          ? {}
          : { waitMs: positiveInt("--wait-ms", values["wait-ms"]) }),
        ...(values.origin === undefined ? {} : { origin: values.origin }),
        json: values.output === "json",
      });
    }
    case "history": {
      const [sub, ...subRest] = rest;
      return historyCommand(sub, subRest);
    }
    case "attach": {
      const { values } = parseArgs({
        args: rest,
        options: {
          origin: { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      return attachViaService({
        ...(values.origin === undefined ? {} : { origin: values.origin }),
        json: values.output === "json",
      });
    }
    /**
     * `odu wait [--run R]` — bounded, resumable attention on one run.
     *
     * A run id is host-global, so this works from any directory about any run,
     * and `odu history list` is how you find one. Bare `odu wait` still means
     * what it always meant — the run in this checkout — but it means it through
     * the CATALOG now rather than by dialling that checkout's socket, which is
     * the authority change. `latest` is the spelling of it, and it therefore
     * also answers about a run whose coordinator has gone.
     */
    case "wait": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          settle: { type: "boolean" },
          run: { type: "string" },
          after: { type: "string" },
          "deadline-ms": { type: "string" },
          // The spelling `odu wait` had before the deadline was a service
          // parameter. Kept, because scripts are written against it and a flag
          // that used to work is not a thing to remove in passing.
          "timeout-ms": { type: "string" },
          "expected-sha": { type: "string" },
          origin: { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      if (positionals.length > 0) {
        throw new Error(
          "odu: wait takes no positional arguments (use --run / --after / --settle)",
        );
      }
      // One deadline, two spellings. `--deadline-ms` is the name the service
      // parameter has; `--timeout-ms` is what this command took before there
      // was a service. Naming both is not ambiguity — it is the same number —
      // so the second is read only when the first is absent.
      const deadline =
        values["deadline-ms"] !== undefined
          ? positiveInt("--deadline-ms", values["deadline-ms"])
          : values["timeout-ms"] !== undefined
            ? positiveInt("--timeout-ms", values["timeout-ms"])
            : undefined;
      return waitViaService({
        run: values.run ?? HERE_AND_NOW,
        ...(values.after === undefined ? {} : { after: values.after }),
        ...(deadline === undefined ? {} : { deadlineMs: deadline }),
        ...(values["expected-sha"] === undefined
          ? {}
          : { expectedSha: values["expected-sha"] }),
        settle: values.settle ?? false,
        ...(values.origin === undefined ? {} : { origin: values.origin }),
        json: values.output === "json",
      });
    }
    /**
     * `odu rerun --run R SELECTOR` — retry, and let odu decide what that means.
     *
     * The policy is the service's: a coordinator still up gets a new attempt on
     * the same run, one that is gone gets a fresh linked replay, and the receipt
     * says which in `mode`. This face used to bind `packagedLauncher()` and make
     * that decision itself — a second retry policy, in a CLI, that the browser
     * and the agent could not see.
     */
    case "rerun": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          run: { type: "string" },
          "request-id": { type: "string" },
          "expect-attempt": { type: "string" },
          origin: { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      if (positionals.length !== 1 || positionals[0] === undefined) {
        throw new Error(
          "odu: rerun needs exactly one argument (node id, @platform, or recipe)",
        );
      }
      // `--expect-attempt` guards against acting on a stale reading, so it has
      // to name WHICH node it is about — and the only node it can name is the
      // selector, because there is nowhere else to put one.
      //
      // So it is refused for a selector that is not a node id. `odu rerun` also
      // takes `@platform` and a bare recipe name, both of which can match
      // several nodes; the guard looks its argument up as a node id, finds
      // nothing, and the service refuses `stale_attempt` — a refusal about a
      // run that has moved on, for a request that was merely unaskable. A usage
      // error naming the reason is the honest answer.
      const target = positionals[0];
      // `indexOf("@") > 0`, not `includes("@")`: a node id is
      // `<namepath>@<platform>`, and a LANE selector is `@<platform>` — which
      // contains an `@` and names no node at all.
      if (values["expect-attempt"] !== undefined && target.indexOf("@") <= 0) {
        throw new Error(
          `odu: --expect-attempt names one node's attempt, but "${target}" is ` +
            "a recipe or a lane, which can match several. Give the full node " +
            "id (`ci::unit@x86_64-linux`), or drop the guard.",
        );
      }
      const expect =
        values["expect-attempt"] === undefined
          ? undefined
          : {
              node: target,
              attempt: positiveInt("--expect-attempt", values["expect-attempt"]),
            };
      return retryViaService({
        run: values.run ?? HERE_AND_NOW,
        selector: positionals[0],
        ...(values["request-id"] === undefined
          ? {}
          : { requestId: values["request-id"] }),
        ...(expect === undefined ? {} : { expectAttempt: expect }),
        ...(values.origin === undefined ? {} : { origin: values.origin }),
        json: values.output === "json",
      });
    }
    /**
     * `odu cancel --run R [node|@platform]` — stop a run, a node, or a lane.
     *
     * Through the service, which dials the coordinator and PROVES it is the run
     * the caller named before it mutates anything. That check is not a nicety:
     * a checkout serves one run after another on one socket path, so the window
     * where a dead run's recorded address and a live run's actual address are
     * the same string is real — and this face used to dial that path directly.
     */
    case "cancel": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          run: { type: "string" },
          "request-id": { type: "string" },
          origin: { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      if (positionals.length > 1) {
        throw new Error(
          "odu: cancel takes at most one argument (node id or @platform)",
        );
      }
      const target = positionals[0];
      // Three EXPLICIT scopes, never a precedence rule. A request that could be
      // read two ways is how somebody who meant to stop one node stops the
      // whole run, so the ambiguity is not expressible.
      const scope =
        target === undefined
          ? ({ kind: "run" } as const)
          : target.startsWith("@")
            ? ({ kind: "lane", platform: target.slice(1) } as const)
            : ({ kind: "node", node: target } as const);
      if (target !== undefined && target.trim() === "") {
        throw new Error(
          "odu: cancel was given an empty argument — pass a node id, an " +
            "@platform, or nothing at all for the whole run",
        );
      }
      return cancelViaService({
        run: values.run ?? HERE_AND_NOW,
        scope,
        ...(values["request-id"] === undefined
          ? {}
          : { requestId: values["request-id"] }),
        ...(values.origin === undefined ? {} : { origin: values.origin }),
        json: values.output === "json",
      });
    }
    // `odu runs` is GONE. Both of its authorities are exactly what a public
    // client may no longer hold: it read the legacy `.ci` ledger off disk and
    // it dialled the checkout's socket to report a dead run. `history list`
    // answers the same question from the authoritative source — and the board's
    // own `owner_lost` state is the dead-run answer, with no dial required.
    case "runs":
      process.stderr.write(
        "odu: `odu runs` has been removed — use `odu history list` (add " +
          "--all for every checkout). It reads the same runs from the shared " +
          "service rather than from this checkout's files, so the -o json " +
          "shape differs.\n",
      );
      return 1;
    case "hosts": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          origin: { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      return hostsViaService({
        platforms: positionals,
        ...(values.origin === undefined ? {} : { origin: values.origin }),
        json: values.output === "json",
      });
    }
    case "lease": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          "no-wait": { type: "boolean" },
          origin: { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      return leaseViaService({
        platforms: positionals,
        noWait: values["no-wait"] ?? false,
        ...(values.origin === undefined ? {} : { origin: values.origin }),
        json: values.output === "json",
      });
    }
    case "release": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          origin: { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      return releaseViaService({
        platforms: positionals,
        ...(values.origin === undefined ? {} : { origin: values.origin }),
        json: values.output === "json",
      });
    }
    case "dump":
    case "graph": {
      const { values } = parseArgs({
        args: rest,
        options: {
          root: { type: "string" },
          origin: { type: "string" },
        },
      });
      return pipelineViaService({
        as: command,
        ...(values.root === undefined ? {} : { root: values.root }),
        ...(values.origin === undefined ? {} : { origin: values.origin }),
      });
    }
    case "protect": {
      const { values } = parseArgs({
        args: rest,
        options: {
          "dry-run": { type: "boolean" },
          branch: { type: "string" },
          platform: { type: "string", multiple: true },
          create: { type: "boolean" },
          origin: { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      // A BLANK `--platform=` IS A USAGE ERROR, refused here.
      //
      // It has to be refused where the argument was typed. Left to the
      // service, it comes back as a refusal — exit 5, "the request itself was
      // refused" — and a malformed argument is not that: nothing was asked of
      // odu that odu declined. It is exit 1, the same as every other unusable
      // argv, which is what it was before `protect` became a client.
      if ((values.platform ?? []).some((p) => p.trim() === "")) {
        throw new Error(
          "odu: --platform expects a Nix system tuple (e.g. x86_64-linux), " +
            "got an empty value",
        );
      }
      return protectViaService({
        dryRun: values["dry-run"] ?? false,
        ...(values.branch === undefined ? {} : { branch: values.branch }),
        platforms: values.platform ?? [],
        create: values.create ?? false,
        ...(values.origin === undefined ? {} : { origin: values.origin }),
        json: values.output === "json",
      });
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
      process.stderr.write(`odu: unknown command "${command}"\n${USAGE}`);
      return 1;
  }
}

/**
 * Exit, but not before what we printed has actually left the process.
 *
 * `process.exit` does not flush a pipe. Writing to a TERMINAL is synchronous,
 * so this never mattered while every command's output was a few lines and a
 * developer was watching it — but `odu logs --run` hands back a whole node's
 * log, and a recipe that emits fourteen megabytes hands back fourteen
 * megabytes. Piped to a file or read by an agent, that write is asynchronous
 * and queued, and exiting on the next tick truncates it: the reader gets a
 * prefix, mid-line, with nothing to say it is a prefix. Measured, not
 * theorised — the e2e suite caught it as `JSON Parse error: Unterminated
 * string` on the noisy fixture's log.
 *
 * The loop is the drain protocol: `write("")` is false while the buffer is
 * still above the high-water mark, and `drain` fires as it comes back under —
 * which for a large backlog can take several rounds. Bounded, because an exit
 * that never happens is worse than an output that is short, and a stdout that
 * cannot drain at all (a reader that went away) is exactly the case where
 * waiting forever is wrong.
 */
async function exitAfterFlush(code: number): Promise<never> {
  for (let round = 0; round < 1024; round += 1) {
    if (process.stdout.write("")) break;
    await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
  }
  process.exit(code);
}

dispatch(process.argv.slice(2)).then(
  (code) => exitAfterFlush(code),
  (err: unknown) => {
    process.stderr.write(`${(err as Error).message}\n`);
    return exitAfterFlush(1);
  },
);
