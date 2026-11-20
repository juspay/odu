import {
  headOf,
  makeFixture,
  removeFixture,
  startRun,
  waitSettled,
  type NodeFailure,
  type Service,
} from "./service.ts";
import { RUN_SETUP_TIMEOUT } from "./budgets.ts";

export interface SharedRun {
  checkout: string;
  runId: string;
  head: string;
  passed: boolean;
  failures: NodeFailure[];
  scenariosThatUsedThisRun: string[];
}

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
    scenariosThatUsedThisRun: [],
  };
}

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

  const now = await waitSettled(service, run.runId, 60_000);
  if (now.passed !== run.passed || now.failures.length !== run.failures.length) {
    throw new Error(
      `web-acceptance: the shared "${name}" run (${run.runId}) is no longer what it was — ` +
        `it settled ${run.passed ? "green" : "red"} with ${run.failures.length} failure(s) and now ` +
        `reads ${now.passed ? "green" : "red"} with ${now.failures.length}. ` +
        "A scenario that RETRIES, CANCELS or SUPERSEDES must ask for a private run " +
        `("a fresh settled red run …"), never this one. Scenarios that have used it: ` +
        `${run.scenariosThatUsedThisRun.join(" · ") || "(none before this)"} — and now "${scenario}".`,
    );
  }
  run.scenariosThatUsedThisRun.push(scenario);
  return run;
}

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
