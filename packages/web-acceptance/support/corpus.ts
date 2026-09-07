/**
 * The runs a scenario READS, cached once per worker.
 *
 * Arranging a run is the expensive thing this suite does — a coordinator that
 * evaluates a flake, realises `odu-runner`, claims a lane and runs real recipes
 * — and about a third of the scenarios here only ever LOOK at one: the board's
 * columns and filters, a log's bytes, a narrow layout, tabbing to a row. Paying
 * a fresh coordinator for each of those would put the leg outside the CI
 * workflow's budget on two platforms, so they share.
 *
 * **Sharing is only ever safe for read-only scenarios**, and that is not left to
 * a comment. Every reuse re-checks that the cached run is still what it was —
 * still settled, still the same verdict, still the same failure set — and a
 * mismatch names every scenario that has touched it. That guard catches the
 * offender one scenario late, which is worth saying plainly: it cannot tell you
 * WHICH of them mutated the run, only that one did and which ones had the
 * chance. A scenario that acts on a run asks for a private one instead, and the
 * step vocabulary keeps the two apart by name ("a settled red run" versus "a
 * fresh settled red run").
 */

import {
  headOf,
  makeFixture,
  removeFixture,
  startRun,
  waitSettled,
  type Service,
} from "./service.ts";
import { RUN_SETUP_TIMEOUT } from "./world.ts";

export interface SharedRun {
  checkout: string;
  runId: string;
  head: string;
  passed: boolean;
  failures: { node: string; logKey: string }[];
  /** Every scenario that has been handed this run, in order. The guard's error
   *  message is only as useful as this list. */
  usedBy: string[];
}

/** Keyed by fixture NAME, not by justfile text: the name is what a step says
 *  and what the guard's message has to be readable about. */
const cache = new Map<string, Promise<SharedRun>>();

async function build(
  service: Service,
  justfile: string,
): Promise<SharedRun> {
  const checkout = makeFixture(justfile);
  const head = headOf(checkout);
  const runId = startRun(service, {
    checkout,
    expectedSha: head,
    requestId: `wa-shared-${crypto.randomUUID()}`,
  });
  const settled = await waitSettled(service, runId, RUN_SETUP_TIMEOUT);
  return {
    checkout,
    runId,
    head,
    passed: settled.passed,
    failures: [...settled.failures],
    usedBy: [],
  };
}

/**
 * The worker's cached run of `name`, built on first ask.
 *
 * `scenario` is recorded rather than used, so the guard below can name who has
 * had their hands on this run when it turns out not to be what it was.
 */
export async function sharedRun(
  service: Service,
  name: string,
  justfile: string,
  scenario: string,
): Promise<SharedRun> {
  let pending = cache.get(name);
  if (pending === undefined) {
    pending = build(service, justfile);
    cache.set(name, pending);
  }
  const run = await pending;

  // The guard. Cheap — the run is settled, so `run_wait` answers at once — and
  // it is the only thing standing between "these scenarios share a run" and a
  // suite whose failures depend on the order cucumber happened to pick.
  const now = await waitSettled(service, run.runId, 60_000);
  if (now.passed !== run.passed || now.failures.length !== run.failures.length) {
    throw new Error(
      `web-acceptance: the shared "${name}" run (${run.runId}) is no longer what it was — ` +
        `it settled ${run.passed ? "green" : "red"} with ${run.failures.length} failure(s) and now ` +
        `reads ${now.passed ? "green" : "red"} with ${now.failures.length}. ` +
        "A scenario that RETRIES, CANCELS or SUPERSEDES must ask for a private run " +
        `("a fresh settled red run …"), never this one. Scenarios that have used it: ` +
        `${run.usedBy.join(" · ") || "(none before this)"} — and now "${scenario}".`,
    );
  }
  run.usedBy.push(scenario);
  return run;
}

/**
 * Drop everything the cache owns.
 *
 * Called from `AfterAll` while the service is still up, which is safe precisely
 * because every run in here is SETTLED — no coordinator is holding a checkout
 * this removes. A private run is the other case and is stopped first, in `After`,
 * for exactly that reason.
 */
export async function clearCorpus(): Promise<void> {
  for (const pending of cache.values()) {
    try {
      removeFixture((await pending).checkout);
    } catch (err) {
      process.stderr.write(`web-acceptance: could not clear a shared fixture: ${String(err)}\n`);
    }
  }
  cache.clear();
}
