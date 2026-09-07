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
 * `<ns>_<verb>`), so the five shared verbs are:
 *
 *   run_start · run_wait · run_retry · run_cancel · log_read
 *
 * spelled identically as an MCP tool, as `odu surface run_start`, and as the
 * procedure `run.start` on the wire. Nothing here renames anything.
 *
 * **`mutates` is a safety default, not a label.** The framework treats an
 * unannotated procedure as MUTATING, because `readOnlyHint: true` lets an MCP
 * host auto-execute a call without confirming it. The two reads below say
 * `mutates: false` deliberately and the three writes are left to the
 * conservative default — which is why `run_wait` and `log_read` are the only
 * entries carrying the flag.
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
  "run.retry": { tool: { mutates: true } },
  "run.cancel": { tool: { mutates: true } },
  "log.read": { tool: { mutates: false } },
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
].join("\n");
