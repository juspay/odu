/**
 * odu — a CI runner you attach to. ஓடு: run.
 *
 *   odu run [recipe[@platform]…] [flags]   run the [metadata("ci")] DAG
 *   odu status [-o json]                   snapshot a live run ({nodes, posting})
 *   odu logs [-f] <node>                   one node's log (replay + follow)
 *   odu attach [-o json]                   live dashboard / transition stream
 *   odu wait [--settle]                    block for fail-fast / settle verdict
 *   odu rerun <node|@plat|recipe>          restart node(s) on the live run
 *   odu cancel [node|@platform]            stop the live run, or one node/lane
 *   odu runs [-o json]                     this checkout's run history
 *   odu history <list|show|import|prune>   the per-user run catalog
 *   odu hosts                              venue inventory (free / busy / held by)
 *   odu lease [PLAT…] [--no-wait]          agent-held venue lease (cross-run)
 *   odu release [PLAT…]                    drop agent-held lease(s)
 *   odu dump                               resolved pipeline as JSON
 *   odu graph                              dependency graph (Mermaid)
 *   odu protect [--dry-run] [--create]     sync required status checks
 *   odu web [--upgrade]                    the singleton web service (all runs)
 *   odu surface <verb>                     the service, projected as argv
 *   odu mcp [--service]                    the agent face (MCP, stdio): this
 *                                          checkout's live run, or --service
 *                                          for every run via the web service
 *
 * Strict by default: refuses a dirty tree, pins HEAD via `git worktree`,
 * posts commit statuses under `<recipe>@<platform>` contexts, splits logs
 * into `.ci/<sha>/<platform>/<recipe>.log`. Opt-outs: `--no-post` (strict,
 * no GitHub writes), `--no-snapshot` (live tree, implies --no-post),
 * `--no-strict` (≡ both — the dev-iteration one-flag opt-out).
 */

import { parseArgs } from "node:util";
import { runCommand } from "@odu/execution/coordinator/run";
import { loadJustPipeline, mermaidGraph } from "@odu/execution/just/ingest";
import {
  attachCommand,
  cancelCommand,
  logsCommand,
  rerunCommand,
  statusCommand,
  waitCommand,
} from "@odu/cli/introspect";
import { hostsCommand } from "@odu/cli/hosts";
import {
  leaseCommand,
  leaseHoldCommand,
  releaseCommand,
} from "@odu/cli/leaseCmd";
import {
  durableLogsCommand,
  durableWaitCommand,
  historyImportCommand,
  historyListCommand,
  historyPruneCommand,
  historyShowCommand,
  retryCommand,
} from "@odu/cli/history";
import { cliRunFace, faceEnv } from "@odu/cli/runFace";
import { mcpCommand } from "@odu/cli/mcp";
import { serviceMcpCommand } from "@odu/cli/serviceMcp";
import { ODU_VERSION } from "@odu/execution/common/version";
import { surfaceCliMain } from "@odu/cli/serviceCli";
import { webCommand, webDaemonCommand } from "@odu/cli/web";
import { protectCommand } from "@odu/cli/protect";
import { runsCommand } from "@odu/cli/runs";

const USAGE = `usage: odu <run|status|logs|attach|wait|rerun|cancel|runs|history|hosts|lease|release|dump|graph|protect|web|surface|mcp> [args]

run [recipe[@platform]…] [--platform P]… [--host P=ADDR]… [--root NAMEPATH]
    [--no-deps] [--no-strict] [--no-snapshot] [--no-post] [--progress json]
    [--supersede] [--linger] [--no-wait]
status [-o json]              # json shape: { nodes, posting }
logs [-f] <node>              # the LIVE run's log (replay + follow)
logs --run R [--attempt N] [--offset B] [--limit B] [-o json] <node>
                              # one RECORDED attempt, after the run is gone.
                              # --offset counts from the start; a NEGATIVE one
                              # is a tail and must be joined: --offset=-4096
attach [-o json]
wait [--settle] [--timeout-ms N] [--expected-sha SHA]
                              # fail-fast verdict JSON; --settle = full settle
wait --run R [--after CURSOR] [--deadline-ms N] [--settle] [-o json]
                              # bounded, resumable. Returns on the first red
                              # you can act on, not on settle. Exits: 0 passed
                              # 1 a failure to act on · 2 still going, nothing
                              # red · 3 owner lost · 4 no such run · 5 refused
rerun <node|@platform|recipe> # restart node(s) on the still-live run
rerun --run R [--request-id ID] [--expect-attempt N] [-o json] <selector>
                              # retry a RECORDED run: a new attempt if its
                              # coordinator is still up, else a new linked run
cancel [node|@platform]       # bare = whole run; node or @plat = partial
runs [-o json]
history <list|show|import|prune>
                              # the per-user run catalog (odu history --help)
hosts
lease [PLAT…] [--no-wait]     hold a free venue across runs (agent layer)
release [PLAT…]               drop agent-held lease(s)
dump [--root NAMEPATH]
graph [--root NAMEPATH]
protect [--dry-run] [--branch B] [--platform P]… [--create]
                              # --create: make the branch's ruleset if absent
web [--upgrade] [-o json]     # ensure the singleton web service, print its URL
                              # (it outlives this shell). --upgrade drains a
                              # running one of another build and starts this one
surface <verb> [--input JSON] [--json]
                              # every registered run, as argv: run_start,
                              # run_wait, run_retry, run_cancel, log_read, and
                              # get/keys/watch/list. odu surface --help lists
                              # them. Exits: 0 answered (red CI included) · 1
                              # refused · 2 usage · 3 nothing serving · 130 interrupted
mcp [--service]               # the agent face over stdio. Bare: the run live in
                              # THIS checkout (run, node_rerun, wait_for_settle,
                              # cancel, runs, node_cancel, lane_cancel, lease,
                              # release). --service: EVERY run, through the web
                              # service — the same five verbs the browser and
                              # odu surface use, and no run authority of its own
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
show --run R [--after CURSOR] [-o json]
                                     one run's attention payload, without waiting
import [--dry-run] [-o json]         bring this checkout's .ci records in
prune [--days N] [--dry-run] [-o json]
                                     expire finished runs past the window (30d)
`;

/** `odu history` — the per-user catalog's own commands. A sub-command group
 *  rather than five top-level verbs: these are all about the CATALOG, and the
 *  top level is about a RUN. */
function historyCommand(sub: string | undefined, rest: string[]): number {
  switch (sub) {
    case "list": {
      const { values } = parseArgs({
        args: rest,
        options: {
          all: { type: "boolean" },
          limit: { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      return historyListCommand({
        json: values.output === "json",
        all: values.all ?? false,
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
          output: { type: "string", short: "o" },
        },
      });
      if (values.run === undefined) {
        throw new Error("odu: history show needs --run (a run id, <sha7>#<seq>, or `latest`)");
      }
      return historyShowCommand({
        run: values.run,
        ...(values.after === undefined ? {} : { after: values.after }),
        json: values.output === "json",
      });
    }
    case "import": {
      const { values } = parseArgs({
        args: rest,
        options: {
          "dry-run": { type: "boolean" },
          output: { type: "string", short: "o" },
        },
      });
      return historyImportCommand({
        json: values.output === "json",
        dryRun: values["dry-run"] ?? false,
      });
    }
    case "prune": {
      const { values } = parseArgs({
        args: rest,
        options: {
          days: { type: "string" },
          "dry-run": { type: "boolean" },
          output: { type: "string", short: "o" },
        },
      });
      return historyPruneCommand({
        json: values.output === "json",
        dryRun: values["dry-run"] ?? false,
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

async function dispatch(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
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
          progress: { type: "string" },
          supersede: { type: "boolean" },
          linger: { type: "boolean" },
          "no-wait": { type: "boolean" },
          // Launcher-only, and deliberately absent from USAGE: a person types
          // `odu run`, a LAUNCHER (`packages/execution/src/coordinator/launcher.ts`) types these.
          // They are argv rather than an env-var side channel because a
          // recovery has to be showable — "here is exactly what would run" is
          // a list a person can read and re-issue, and never a string anything
          // evals.
          "expected-sha": { type: "string" },
          "run-id": { type: "string" },
          "parent-run": { type: "string" },
          "request-id": { type: "string" },
        },
      });
      if (values.progress !== undefined && values.progress !== "json") {
        throw new Error(`odu: unknown --progress format "${values.progress}"`);
      }
      // THE FACE IS SUPPLIED HERE, and only here. The coordinator's default is
      // silence — see `RunDeps.face` — so a terminal matrix, an NDJSON stream
      // and a piped transition log are all this command's decision, not the
      // engine's.
      return runCommand({
        selectors: positionals,
        platforms: values.platform ?? [],
        hostPins: values.host ?? [],
        root: values.root,
        noDeps: values["no-deps"] ?? false,
        noStrict: values["no-strict"] ?? false,
        noSnapshot: values["no-snapshot"] ?? false,
        noPost: values["no-post"] ?? false,
        supersede: values.supersede ?? false,
        linger: values.linger ?? false,
        noWait: values["no-wait"] ?? false,
        ...(values["expected-sha"] === undefined
          ? {}
          : { expectedSha: values["expected-sha"] }),
        ...(values["run-id"] === undefined ? {} : { runId: values["run-id"] }),
        ...(values["parent-run"] === undefined
          ? {}
          : { parentRunId: values["parent-run"] }),
        ...(values["request-id"] === undefined
          ? {}
          : { requestId: values["request-id"] }),
      }, {
        face: cliRunFace({
          ...faceEnv(),
          progressJson: values.progress === "json",
        }),
      });
    }
    case "status": {
      const { values } = parseArgs({
        args: rest,
        options: { output: { type: "string", short: "o" } },
      });
      return statusCommand(values.output === "json");
    }
    case "logs": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          follow: { type: "boolean", short: "f" },
          run: { type: "string" },
          attempt: { type: "string" },
          offset: { type: "string" },
          limit: { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      const node = positionals[0];
      if (node === undefined) throw new Error("odu: logs needs a node id");
      // `--run` switches the SOURCE, not the command: without it this is the
      // live socket's log stream exactly as it always was (including `-f`),
      // with it this is one recorded attempt out of the durable catalog. They
      // are one command because "show me this node's output" is one question,
      // and the difference is only which run you mean.
      if (values.run === undefined) {
        if (values.attempt !== undefined) {
          throw new Error(
            "odu: --attempt addresses a recorded run — pass --run too (a live run's log has no attempt to choose)",
          );
        }
        return logsCommand(node, values.follow ?? false);
      }
      if (values.follow === true) {
        throw new Error(
          "odu: -f follows a LIVE node's log; a recorded attempt is already complete (drop -f, or drop --run)",
        );
      }
      return durableLogsCommand({
        run: values.run,
        node,
        ...(values.attempt === undefined
          ? {}
          : { attempt: positiveInt("--attempt", values.attempt) }),
        ...(values.offset === undefined
          ? {}
          : { offset: integer("--offset", values.offset) }),
        ...(values.limit === undefined
          ? {}
          : { limit: positiveInt("--limit", values.limit) }),
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
        options: { output: { type: "string", short: "o" } },
      });
      return attachCommand(values.output === "json");
    }
    case "wait": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          settle: { type: "boolean" },
          "timeout-ms": { type: "string" },
          "expected-sha": { type: "string" },
          run: { type: "string" },
          after: { type: "string" },
          "deadline-ms": { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      if (positionals.length > 0) {
        throw new Error(
          "odu: wait takes no positional arguments (use --settle / --timeout-ms / --expected-sha)",
        );
      }
      // The ADDRESSED wait: a named run out of the durable catalog, resumable
      // across disconnects with `--after`, and with its own documented exits
      // (see WAIT_EXITS) because "not yet" and "it failed" are different
      // answers. The bare `odu wait` below is unchanged — it blocks on THIS
      // checkout's live socket and still exits 0 or 1.
      if (values.run !== undefined) {
        if (values["expected-sha"] !== undefined) {
          throw new Error(
            "odu: --expected-sha guards a LIVE run's identity; --run already names one exactly",
          );
        }
        if (values["timeout-ms"] !== undefined) {
          throw new Error(
            "odu: use --deadline-ms with --run (reaching it means still_running, not a timeout failure)",
          );
        }
        return durableWaitCommand({
          run: values.run,
          ...(values.after === undefined ? {} : { after: values.after }),
          ...(values["deadline-ms"] === undefined
            ? {}
            : { deadlineMs: positiveInt("--deadline-ms", values["deadline-ms"]) }),
          settle: values.settle ?? false,
          json: values.output === "json",
        });
      }
      let timeoutMs: number | undefined;
      if (values["timeout-ms"] !== undefined) {
        const raw = values["timeout-ms"].trim();
        // Number("") === 0 would silently mean "timeout immediately".
        timeoutMs = raw === "" ? Number.NaN : Number(raw);
        // setTimeout signed-32-bit limit — larger values are a usage error.
        if (
          !Number.isFinite(timeoutMs) ||
          timeoutMs < 0 ||
          timeoutMs > 2_147_483_647
        ) {
          throw new Error(
            `odu: --timeout-ms must be a non-negative number ≤ 2147483647 (got "${values["timeout-ms"]}")`,
          );
        }
      }
      const expectedSha = values["expected-sha"];
      if (expectedSha !== undefined && expectedSha.trim() === "") {
        throw new Error("odu: --expected-sha needs a commit sha");
      }
      return waitCommand({
        settle: values.settle ?? false,
        timeoutMs,
        expectedSha,
      });
    }
    case "rerun": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          run: { type: "string" },
          "request-id": { type: "string" },
          "expect-attempt": { type: "string" },
          output: { type: "string", short: "o" },
        },
      });
      if (positionals.length !== 1 || positionals[0] === undefined) {
        throw new Error(
          "odu: rerun needs exactly one argument (node id, @platform, or recipe)",
        );
      }
      // Bare `rerun` still means "on the run live in this checkout" and is
      // untouched. `--run` addresses a RECORDED run, and then odu — not the
      // caller — decides whether that means a new attempt on a coordinator
      // still going or a fresh linked run: which one applies is a fact about
      // the run, and making a caller choose is how it gets chosen wrongly.
      if (values.run === undefined) {
        if (values["request-id"] !== undefined || values["expect-attempt"] !== undefined) {
          throw new Error(
            "odu: --request-id and --expect-attempt address a recorded run — pass --run too",
          );
        }
        return rerunCommand(positionals[0]);
      }
      return retryCommand({
        run: values.run,
        selector: positionals[0],
        ...(values["request-id"] === undefined
          ? {}
          : { requestId: values["request-id"] }),
        ...(values["expect-attempt"] === undefined
          ? {}
          : {
              expectAttempt: positiveInt(
                "--expect-attempt",
                values["expect-attempt"],
              ),
            }),
        json: values.output === "json",
      });
    }
    case "cancel": {
      const { positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {},
      });
      if (positionals.length > 1) {
        throw new Error(
          "odu: cancel takes at most one argument (node id or @platform)",
        );
      }
      // undefined = bare full-run cancel; a present empty string is rejected
      // inside cancelCommand (never escalates to full-run teardown).
      return cancelCommand(positionals[0]);
    }
    case "runs": {
      const { values } = parseArgs({
        args: rest,
        options: { output: { type: "string", short: "o" } },
      });
      return runsCommand(values.output === "json");
    }
    case "hosts":
      return hostsCommand();
    case "lease": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { "no-wait": { type: "boolean" } },
      });
      const r = await leaseCommand({
        platforms: positionals,
        noWait: values["no-wait"] ?? false,
        nonBlocking: false,
      });
      return r.code;
    }
    case "release": {
      const { positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {},
      });
      return releaseCommand({ platforms: positionals });
    }
    case "lease-hold": {
      // Hidden: detached holder process. Not listed in usage.
      const { values } = parseArgs({
        args: rest,
        options: {
          platform: { type: "string" },
          repo: { type: "string" },
          "no-wait": { type: "boolean" },
        },
      });
      if (values.platform === undefined || values.platform === "") {
        throw new Error("odu lease-hold: --platform is required");
      }
      return leaseHoldCommand({
        platform: values.platform,
        noWait: values["no-wait"] ?? false,
        repoRoot: values.repo ?? process.cwd(),
      });
    }
    case "dump":
    case "graph": {
      const { values } = parseArgs({
        args: rest,
        options: { root: { type: "string" } },
      });
      const spec = loadJustPipeline(process.cwd(), { root: values.root });
      process.stdout.write(
        command === "dump"
          ? `${JSON.stringify(spec, null, 2)}\n`
          : mermaidGraph(spec),
      );
      return 0;
    }
    case "protect": {
      const { values } = parseArgs({
        args: rest,
        options: {
          "dry-run": { type: "boolean" },
          branch: { type: "string" },
          platform: { type: "string", multiple: true },
          create: { type: "boolean" },
        },
      });
      return protectCommand({
        dryRun: values["dry-run"] ?? false,
        branch: values.branch,
        platforms: values.platform ?? [],
        create: values.create ?? false,
      });
    }
    case "web": {
      const { values } = parseArgs({
        args: rest,
        options: {
          upgrade: { type: "boolean" },
          output: { type: "string", short: "o" },
        },
      });
      return webCommand({
        upgrade: values.upgrade ?? false,
        json: values.output === "json",
      });
    }
    // The daemon `odu web` spawns. Deliberately absent from USAGE: a person
    // types `odu web`, and only a supervisor types this — running it by hand
    // in a terminal would tie the service's life to that terminal, which is
    // the one property the singleton exists to not have.
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
        options: { service: { type: "boolean" } },
      });
      // TWO SUBJECTS, one binary. The default face is about the run live in
      // THIS checkout — it dies with that run, its resources are that run's,
      // and its nine tools are a published contract consumers configure by
      // name. `--service` is about EVERY run: it dials the singleton and
      // projects the same five verbs the browser and `odu surface` use, under
      // the same names, and holds no run authority of its own.
      //
      // A flag rather than a replacement because the two answer different
      // questions and consumers already depend on the first. Which one a host
      // wants is a fact about the host, so it is spelled in its config.
      return values.service === true
        ? serviceMcpCommand({ version: ODU_VERSION })
        : mcpCommand();
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
