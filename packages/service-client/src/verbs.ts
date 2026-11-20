import type { ExposeMap } from "@kolu/surface/expose";
import type { oduServiceSurface } from "./surface";

type ServiceSpec = (typeof oduServiceSurface)["spec"];

/** The default-deny allowlist every projecting face applies.
 *
 *  **`mutates` is a safety default, not a label.** The framework treats an
 *  unannotated procedure as MUTATING, because `readOnlyHint: true` lets an MCP
 *  host auto-execute a call without confirming it. Every entry below carries the
 *  flag explicitly even so. */
export const ODU_SERVICE_EXPOSE = {
  service: "resource",
  venues: "resource",
  runs: "resource",
  logTails: "resource",
  "run.start": { tool: { mutates: true } },
  "run.wait": { tool: { mutates: false } },
  "run.read": { tool: { mutates: false } },
  "run.list": { tool: { mutates: false } },
  "run.retry": { tool: { mutates: true } },
  "run.cancel": { tool: { mutates: true } },
  "log.read": { tool: { mutates: false } },
  "catalog.import": { tool: { mutates: true } },
  "catalog.prune": { tool: { mutates: true } },
  "pipeline.read": { tool: { mutates: false } },
  "venue.probe": { tool: { mutates: false } },
  "venue.hold": { tool: { mutates: true } },
  "venue.release": { tool: { mutates: true } },
  "protect.apply": { tool: { mutates: true } },
} as const satisfies ExposeMap<ServiceSpec>;

/** The `instructions` an MCP host is handed at `initialize`. */
export const ODU_SERVICE_MCP_INSTRUCTIONS = [
  "odu runs a repository's `just` recipe DAG across machines and keeps every run",
  "in a per-user catalog. This face addresses runs GLOBALLY by run id — nothing",
  "here depends on your working directory, and `run_start` takes the checkout it",
  "should run in as an explicit absolute path.",
  "",
  "The loop: `run_start` (with an `expectedSha` and your own `requestId`) →",
  "`run_wait` (bounded; feed back the `cursor` it returns as `after`) →",
  "`log_read` on a failure's `logKey` → `run_retry` for the same commit, or a",
  "fresh `run_start` for a new one.",
  "",
  "THE CHECKOUT IS THE SERVICE'S, not yours. `checkout` is an absolute path on",
  "the machine this daemon runs on, and `expectedSha` is the commit YOU believe",
  "is there — a checkout that has moved on is refused rather than run. The same",
  "pair from a shell is `odu ci run --checkout <path> --sha <sha>`, which needs",
  "the service NAMED (`--origin`, or `$ODU_WEB_ORIGIN`): the default one is the",
  "daemon for the directory you are standing in. A run records `actor` — who",
  "started it.",
  "",
  "A `run_wait` that answers `reason: \"failure\"` is a NORMAL result, not a tool",
  "error: CI went red and here is what to read. A tool error means odu refused",
  "the request itself. `reason: \"still_running\"` means the deadline was reached",
  "with nothing red — ask again with the cursor.",
  "",
  "A RUN PUSHES WHAT IT BUILDS. Every recipe's `result*` closure goes to the",
  "odu cache the repository's `flake.nix` `nixConfig` already reads from, when",
  "this daemon serves it — no step in any recipe and no token in the tree.",
  "`run_read` answers `push`: the bucket and how much landed, or `target: null`",
  "and a `skipped` reason saying why nothing was. A push that fails makes that node",
  "RED, so green means the cache is warm.",
  "",
  "Retrying is not your choice to make: `run_retry` resets nodes on a live",
  "coordinator when there is one and starts a linked replay run when there is",
  "not, and tells you which it did in `mode`. Watch `effectiveRun`, not the run",
  "you asked about.",
  "",
  "`log_read` also FOLLOWS. Pass `waitMs` and it holds until the log grows past",
  "the end of this page, the attempt finishes, or the deadline passes. Feed",
  "`nextOffset` back as `offset` — that is the cursor, and YOU hold it, so a",
  "call that dies is re-issued rather than resumed. Stop when `open` is false;",
  "`complete` then says whether you have the whole log or a truncated one. A",
  "`size` smaller than the offset you asked for means that attempt was re-run",
  "and its log rewritten — start again from 0.",
  "A node has TWO logs under the one `logKey`: `stream` absent is the recipe's",
  "own output, and `\"push\"` is the separate step that uploaded what it built —",
  "where a node that passed its recipe and still went red says why.",
  "",
  "`run_read` is `run_wait` without the waiting — the same answer, now.",
  "`run_list` filters the board by checkout, commit and seq without fetching",
  "every row — how to find a run id you do not have.",
  "",
  "The rest address things other than a run. `pipeline_read` resolves a",
  "checkout's recipe DAG without running it. `venue_probe` lists the machines",
  "and who holds them; `venue_hold` / `venue_release` take and drop a hold that",
  "outlives your session. `catalog_import` / `catalog_prune` maintain the run",
  "catalog. `protect_apply` sets a branch's required status checks to exactly",
  "the contexts odu posts — use `dryRun` first and read `contexts`.",
  ""
].join("\n");
