/**
 * The ONE projection policy — what an agent and a terminal may reach, and what
 * each verb is called.
 *
 * `@kolu/surface-cli` and `@kolu/surface-mcp` are two projections of one
 * surface, and both read the SAME `expose` map by the same grammar. That is the
 * whole reason this file exists rather than a map at each face: a verb that
 * meant one thing to an agent and another to a terminal would be a difference
 * nobody could see until an agent and a person disagreed about what they had
 * just done to the same run.
 *
 * The names fall out of the framework's own derivation (`toolName(ns, verb)` is
 * `<ns>_<verb>`), so the shared verbs are:
 *
 *   run_start · run_wait · run_read · run_retry · run_cancel · log_read
 *   catalog_import · catalog_prune · pipeline_read
 *   venue_probe · venue_hold · venue_release · protect_apply
 *
 * spelled identically as an MCP tool, as `odu surface run_start`, and as the
 * procedure `run.start` on the wire. Nothing here renames anything.
 *
 * **The list grew, and that is the point.** It was five, and five was not a
 * design — it was the subset of odu's public capabilities that had been moved
 * so far. `odu status`, `odu hosts`, `odu lease`, `odu history import` and
 * `odu protect` each did their own work in the caller's process, so an agent
 * and a browser simply could not do those things at all, and each command that
 * could was its own small authority. Every public capability now has exactly
 * one implementation and every face can reach it.
 *
 * **The follow is a PARAMETER, not a fourteenth verb.** `log_read` takes
 * `waitMs` and answers when the log grows. A stream member would have been the
 * obvious shape and is the wrong one: a stream that takes an input cannot be a
 * static MCP resource — the same rule that keeps `nodes` off this list — so it
 * would have given the browser and the terminal a follow and left an agent
 * with the one-page read.
 *
 * **`mutates` is a safety default, not a label.** The framework treats an
 * unannotated procedure as MUTATING, because `readOnlyHint: true` lets an MCP
 * host auto-execute a call without confirming it. Every entry below carries the
 * flag explicitly even so: five reads say `mutates: false`, and the eight writes
 * say `true` rather than leaning on the default. Relying on the default was
 * fine while the map was five lines long and one could see the whole thing at
 * once; at thirteen, "this one is unannotated, so it is a write" is a fact a
 * reader has to reconstruct, and the one it is easiest to get wrong is a new
 * entry somebody meant to be a read.
 */

import type { ExposeMap } from "@kolu/surface/expose";
import type { oduServiceSurface } from "./surface";

type ServiceSpec = (typeof oduServiceSurface)["spec"];

/**
 * The default-deny allowlist every projecting face applies.
 *
 * `service` is a resource because "which build am I talking to" is a question
 * an agent has to be able to ask before it trusts an answer, and a browser has
 * to be able to draw. `runs` and `logTails` are the board and the live tail.
 * `nodes` is deliberately ABSENT: it is a stream whose input is a run id, and a
 * stream that requires an input cannot be a static MCP resource — the DAG is
 * reached through the browser's own subscription, and an agent reads a run's
 * shape from `run_wait`'s answer, which is the payload built for exactly that.
 */
export const ODU_SERVICE_EXPOSE = {
  service: "resource",
  runs: "resource",
  logTails: "resource",
  "run.start": { tool: { mutates: true } },
  "run.wait": { tool: { mutates: false } },
  "run.read": { tool: { mutates: false } },
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

/** The `instructions` an MCP host is handed at `initialize` — where the domain
 *  gets taught, since a tool list cannot say what a RUN is or why a red answer
 *  is not an error. */
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
  "A `run_wait` that answers `reason: \"failure\"` is a NORMAL result, not a tool",
  "error: CI went red and here is what to read. A tool error means odu refused",
  "the request itself. `reason: \"still_running\"` means the deadline was reached",
  "with nothing red — ask again with the cursor.",
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
  "",
  "`run_read` is `run_wait` without the waiting — the same answer, now.",
  "",
  "The rest address things other than a run. `pipeline_read` resolves a",
  "checkout's recipe DAG without running it. `venue_probe` lists the machines",
  "and who holds them; `venue_hold` / `venue_release` take and drop a hold that",
  "outlives your session. `catalog_import` / `catalog_prune` maintain the run",
  "catalog. `protect_apply` sets a branch's required status checks to exactly",
  "the contexts odu posts — use `dryRun` first and read `contexts`.",
].join("\n");
