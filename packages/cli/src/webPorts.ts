/**
 * HOW THE WEB FACE REACHES THE ENGINE — the four ports, implemented.
 *
 * `@odu/service` owns cross-run authority and cannot import `@odu/execution`;
 * the three things it must CAUSE arrive as function types. This module is what
 * those types are bound to, and it is the only place on the web face's side of
 * the wall that knows what a coordinator is.
 *
 * It sits apart from `./web` on purpose. That file is a COMPOSITION ROOT and a
 * process lifecycle — claim the gate, bind the listener, serve, tear down — and
 * an adapter that has to reason about ownership records, run identity and
 * teardown confirmation is not lifecycle. Their reasons to change are different
 * ones: this file moves when the engine's contract does, that one when the
 * daemon's does.
 *
 * The interesting half is `cancel`, and the note on {@link cancelThroughSocket}
 * is why.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dialRun } from "@odu/run-client/dial";
import { firstFrame, runUnary } from "@odu/execution/common/effectEdge";
import { packagedLauncher } from "@odu/execution/coordinator/launcher";
import {
  isSameRun,
  retryRun as retryRecordedRun,
} from "@odu/execution/coordinator/recovery";
import { gitBranch } from "@odu/execution/common/git";
import { type CatalogOptions, listRuns } from "@odu/run-history/store";
import type {
  CancelOutcome,
  CancelRequest,
  CheckoutFacts,
  ServicePorts,
} from "@odu/service/ports";

/**
 * What the service can learn about a checkout without running anything.
 *
 * The live-run question is asked of the CATALOG, not of the checkout: a socket
 * file is not a run (it outlives the coordinator that made it), and the
 * ownership record is the copy a heartbeat refreshes and a clean exit clears.
 * Asking the catalog also means the answer is a run ID a caller can address,
 * rather than "something is listening over there".
 *
 * **The catalog is asked with GIT'S OWN NAME for the checkout**, not with the
 * path the caller typed. A run records `repoRoot` from the coordinator's
 * `--show-toplevel`, which is resolved; a caller's path need not be. On macOS
 * `/tmp` is a symlink to `/private/tmp`, so the two are routinely different
 * strings for one directory — and comparing them as given made a busy checkout
 * look free. The service then launched, the coordinator refused the checkout it
 * could see was busy, and the caller got `launch_failed` where the answer was
 * "that run is already there".
 */
export function probeCheckout(
  checkout: string,
  catalog: CatalogOptions = {},
): CheckoutFacts {
  if (!existsSync(checkout)) {
    return { isRepo: false, head: null, branch: null, liveRunId: null };
  }
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: checkout,
    encoding: "utf-8",
  });
  if (top.status !== 0) {
    return { isRepo: false, head: null, branch: null, liveRunId: null };
  }
  const head = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: checkout,
    encoding: "utf-8",
  });
  const live = listRuns({ ...catalog, repoRoot: top.stdout.trim() }).find(
    (row) => row.liveness === "owned" && row.endpoint !== null,
  );
  return {
    isRepo: true,
    head: head.status === 0 ? head.stdout.trim() : null,
    branch: gitBranch(checkout),
    liveRunId: live?.runId ?? null,
  };
}

/** The ports the service is bound to — the ONE place the web face is wired to
 *  the engine. Everything below this line knows what a coordinator is;
 *  `@odu/service` does not. */
export function webPorts(): ServicePorts {
  const launcher = packagedLauncher();
  return {
    launch: launcher,
    retry: (request) =>
      retryRecordedRun({
        runId: request.runId,
        selector: request.selector,
        ...(request.requestId === undefined
          ? {}
          : { requestId: request.requestId }),
        ...(request.expectAttempt === undefined
          ? {}
          : { expectAttempt: request.expectAttempt }),
        ...(request.catalog === undefined ? {} : { catalog: request.catalog }),
        launcher,
      }),
    cancel: cancelThroughSocket,
    probeCheckout,
  };
}

/** How long a whole-run cancel waits for the socket to go away before it says
 *  it does not know. Teardown finalizes posted statuses and closes lanes, so it
 *  is not instant; bounded, because a caller must eventually be answered. */
const TEARDOWN_CONFIRM_MS = 10_000;

/** Has the coordinator let go of this socket? The run surface's own documented
 *  confirmation for a cancel — the ack may never flush, the socket always
 *  goes. */
async function socketGone(endpoint: string): Promise<boolean> {
  const dialed = await dialRun(endpoint).catch(() => null);
  if (dialed === null) return true;
  await dialed.close();
  return false;
}

/**
 * Reach the coordinator serving a run and stop what the caller named — after
 * proving it is that run.
 *
 * The identity check is not a nicety. `owner.json` keeps a crashed
 * coordinator's endpoint for the ownership grace, and a checkout serves one run
 * after another on one socket path, so the window where "the address the dead
 * run recorded" and "the address the live run is on" are the same string is a
 * real one. `isSameRun` is the retry policy's own comparison, reused rather
 * than re-derived: one answer to "is this the run I mean".
 */
async function cancelThroughSocket(
  request: CancelRequest,
): Promise<CancelOutcome> {
  const dispatched = await dispatchCancel(request);
  if (dispatched.kind !== "await-teardown") return dispatched;
  // The whole-run case, and the connection is CLOSED before this: the caller
  // confirms teardown by the socket going away, and a dial this process is
  // still holding open is not a socket that has gone away.
  const deadline = Date.now() + TEARDOWN_CONFIRM_MS;
  for (;;) {
    if (await socketGone(request.endpoint)) {
      return { kind: "cancelled", detail: null };
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return dispatched.acked
    ? {
        // It said yes. Teardown finalizes posted statuses and closes lanes, and
        // a slow one is not a failed one.
        kind: "cancelled",
        detail: "the coordinator accepted the cancel and is still shutting down",
      }
    : {
        kind: "unresolved",
        detail:
          "the coordinator did not answer and its socket is still up after " +
          `${Math.round(TEARDOWN_CONFIRM_MS / 1000)}s`,
      };
}

/** Dial, prove it is the right run, mutate, and let go. `await-teardown` is the
 *  whole-run arm, which cannot be settled from this side of the connection. */
async function dispatchCancel({
  endpoint,
  runId,
  expect,
  scope,
}: CancelRequest): Promise<
  CancelOutcome | { kind: "await-teardown"; acked: boolean }
> {
  const dialed = await dialRun(endpoint);
  // Nothing serving that path. An ANSWER, not a failure: the run the caller
  // named has no coordinator to stop, and saying so beats a cheerful ok.
  if (dialed === null) {
    return { kind: "declined", detail: "nothing is serving this run's socket" };
  }
  try {
    const state = await firstFrame(dialed.client.surface.nodes.get(undefined));
    if (state === undefined || !isSameRun(expect, state)) {
      return {
        kind: "declined",
        detail:
          `the coordinator on this checkout's socket is not run ${runId} — ` +
          "that run's coordinator is gone and another has taken the checkout, " +
          "so nothing was cancelled",
      };
    }
    switch (scope.kind) {
      case "run": {
        // The reply may never arrive: this call routes into the same teardown a
        // SIGINT takes, and the coordinator may exit before it flushes. So the
        // ack is not what is believed — the socket is — and this arm carries the
        // ack out only as a tiebreaker for the case where the socket stays up.
        const acked = await runUnary(dialed.client.surface.run.cancel({}))
          .then(() => true)
          .catch(() => false);
        return { kind: "await-teardown", acked };
      }
      case "node": {
        const result = await runUnary(
          dialed.client.surface.node.cancel({ id: scope.node }),
        );
        return result.ok
          ? { kind: "cancelled", detail: null }
          : {
              kind: "declined",
              detail: `this run has no node ${scope.node} to cancel`,
            };
      }
      case "lane": {
        const result = await runUnary(
          dialed.client.surface.lane.cancel({ platform: scope.platform }),
        );
        return result.ok
          ? { kind: "cancelled", detail: null }
          : {
              kind: "declined",
              detail: `this run has no ${scope.platform} lane to cancel`,
            };
      }
    }
  } catch (err) {
    // A node or lane cancel whose reply was lost. Those do NOT tear the socket
    // down, so there is no second signal to confirm them by — and a mutation
    // with no confirmation is exactly what `unresolved` is for.
    return {
      kind: "unresolved",
      detail: `the call to the coordinator failed — ${(err as Error).message}`,
    };
  } finally {
    await dialed.close();
  }
}
