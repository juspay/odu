import { parseArgs } from "node:util";
import { LOG_STREAMS, type LogStream } from "@odu/service-client/surface";
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
} from "./serviceCommands";
import { attachViaService, statusViaService } from "./serviceStatus";
import { hostsViaService, leaseViaService, releaseViaService } from "./serviceVenue";
import { pipelineViaService, protectViaService } from "./servicePipeline";

export const CI_USAGE = `usage: odu ci <run|wait|rerun|cancel|logs|history|status|attach|hosts|lease|release|dump|graph|protect> [args]

Every command below is a client of the shared odu service. It is started for you
if none is running; nothing here runs CI by itself.

run [recipe[@platform]…] [--platform P]… [--host P=ADDR]… [--root NAMEPATH]
    [--checkout ABS --sha SHA [--branch NAME]] [--no-deps] [--no-strict]
    [--no-snapshot]
    [--no-post] [--supersede] [--no-wait] [--request-id ID] [--progress json]
    [-o json]
                              # start a run in THIS checkout and watch it.
                              # Ctrl-C stops watching; the run keeps going.
                              # --checkout names a path on the SERVICE's
                              # machine instead. It needs a service NAMED
                              # (--origin or $ODU_WEB_ORIGIN; the default is
                              # the daemon for where you stand) and REQUIRES
                              # --sha: the commit you believe is there, which
                              # the service refuses if it moved. Your
                              # $ODU_HOSTS is still sent when it names a
                              # path (one the service has not got falls
                              # through to its chain); with none set,
                              # nothing is sent and the service's own stands.
                              # --branch lets the service FETCH and move that
                              # clone onto NAME at --sha when it is not there
                              # already (it refuses a dirty tree, and a sha
                              # that is not on the branch). Without it a
                              # checkout that moved is refused, as before.
                              # A clone must be ON a branch for a run's pins:
                              # a detached HEAD pins nothing.
                              # Every recipe's result* closure is pushed to
                              # the odu cache this repository's flake.nix
                              # nixConfig already reads from, when this daemon
                              # serves it. Nothing in any recipe, no token;
                              # _ci-setup says where, or why not.
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
logs <log-key> [-f] [--offset B] [--limit B] [--wait-ms N] [--stream S] [-o json]
                              # ECHO the logKey a failure reported. --offset
                              # counts from the start; a NEGATIVE one is a tail
                              # and must be joined: --offset=-4096.
                              # -f follows to the end: exits 0 with the whole
                              # log, 1 if it was truncated.
                              # --stream push reads the same attempt's PUSH
                              # step instead of its recipe (default: recipe)
history <list|show|import|prune>
                              # the per-user run catalog (odu ci history --help)
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

--origin URL is accepted by every command here (default $ODU_WEB_ORIGIN or
http://127.0.0.1:18440). A named origin is dialled and only dialled: odu starts
a service for you only when you meant the default one.
`;

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

function logStream(raw: string): LogStream {
  const found = LOG_STREAMS.find((one) => one === raw);
  if (found === undefined) {
    throw new Error(
      `odu: --stream takes ${LOG_STREAMS.join(" or ")} (got "${raw}")`,
    );
  }
  return found;
}

type ProgressFormat = "json";

function progressFormat(raw: string): ProgressFormat {
  if (raw !== "json") {
    throw new Error(`odu: unknown --progress format "${raw}"`);
  }
  return raw;
}

function isNodeId(selector: string): boolean {
  return selector.indexOf("@") > 0;
}

function deadlineMsFrom(values: {
  "deadline-ms"?: string | undefined;
  "timeout-ms"?: string | undefined;
}): number | undefined {
  const deadline = values["deadline-ms"];
  if (deadline !== undefined) return positiveInt("--deadline-ms", deadline);
  const timeout = values["timeout-ms"];
  if (timeout !== undefined) return positiveInt("--timeout-ms", timeout);
  return undefined;
}

const HISTORY_USAGE = `usage: odu ci history <list|show|import|prune> [args]

list [--all] [--limit N] [-o json]   runs in the per-user catalog, newest first
show [--run R] [--after CURSOR] [-o json]
                                     one run's attention payload, without waiting
import [--dry-run] [-o json]         bring this checkout's .ci records in
prune [--days N] [--dry-run] [-o json]
                                     expire finished runs past the window (30d)
`;

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
        run: values.run ?? LATEST_IN_THIS_CHECKOUT,
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

const LATEST_IN_THIS_CHECKOUT = "latest";

export async function ciCommand(
  sub: string | undefined,
  rest: string[],
): Promise<number> {
  switch (sub) {
    case "run": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          platform: { type: "string", multiple: true },
          host: { type: "string", multiple: true },
          root: { type: "string" },
          checkout: { type: "string" },
          sha: { type: "string" },
          branch: { type: "string" },
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
      const progress =
        values.progress === undefined
          ? undefined
          : progressFormat(values.progress);
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
        ...(progress === undefined ? {} : { progressJson: true }),
        ...(values["request-id"] === undefined
          ? {}
          : { requestId: values["request-id"] }),
        ...(values.origin === undefined ? {} : { origin: values.origin }),
        ...(values.checkout === undefined ? {} : { checkout: values.checkout }),
        ...(values.sha === undefined ? {} : { sha: values.sha }),
        ...(values.branch === undefined ? {} : { branch: values.branch }),
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
    case "logs": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          offset: { type: "string" },
          limit: { type: "string" },
          follow: { type: "boolean", short: "f" },
          "wait-ms": { type: "string" },
          stream: { type: "string" },
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
        ...(values.stream === undefined
          ? {}
          : { stream: logStream(values.stream) }),
        ...(values.origin === undefined ? {} : { origin: values.origin }),
        json: values.output === "json",
      });
    }
    case "history": {
      const [historySub, ...historyRest] = rest;
      return historyCommand(historySub, historyRest);
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
    case "wait": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          settle: { type: "boolean" },
          run: { type: "string" },
          after: { type: "string" },
          "deadline-ms": { type: "string" },
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
      const deadline = deadlineMsFrom(values);
      return waitViaService({
        run: values.run ?? LATEST_IN_THIS_CHECKOUT,
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
      const target = positionals[0];
      if (values["expect-attempt"] !== undefined && !isNodeId(target)) {
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
        run: values.run ?? LATEST_IN_THIS_CHECKOUT,
        selector: positionals[0],
        ...(values["request-id"] === undefined
          ? {}
          : { requestId: values["request-id"] }),
        ...(expect === undefined ? {} : { expectAttempt: expect }),
        ...(values.origin === undefined ? {} : { origin: values.origin }),
        json: values.output === "json",
      });
    }
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
        run: values.run ?? LATEST_IN_THIS_CHECKOUT,
        scope,
        ...(values["request-id"] === undefined
          ? {}
          : { requestId: values["request-id"] }),
        ...(values.origin === undefined ? {} : { origin: values.origin }),
        json: values.output === "json",
      });
    }
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
        as: sub,
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
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(CI_USAGE);
      return sub === undefined ? 1 : 0;
    default:
      process.stderr.write(`odu: unknown ci sub-command "${sub}"\n${CI_USAGE}`);
      return 1;
  }
}
