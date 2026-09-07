/**
 * A catalog on disk, and a service over it — the world these tests state.
 *
 * Every test here drives REAL FILES: `registerRun`, `openJournal` and the
 * attempt store are the catalog's own writers, so what a projection reads is
 * what a coordinator would have written. Faking the catalog would make these
 * tests about a stand-in, and the whole class of bug this package can have is a
 * disagreement between a projection and the records it projects.
 *
 * What IS stubbed is the three PORTS — launching, retrying, cancelling — for
 * the reason the ports exist: none of them can be exercised without a process,
 * and every path through acceptance, receipts and reconciliation can be
 * exercised without one.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintRunId } from "@odu/run-history/ids";
import {
  appendEvent,
  openJournal,
  registerRun,
  type RunHandle,
  sealAttempt,
  startAttempt,
  writeAttemptLog,
  writeVerdict,
} from "@odu/run-history/store";
import type { OwnershipToken } from "@odu/run-history/owner";
import type { RunScope } from "@odu/run-history/schema";
import type {
  CheckoutFacts,
  LaunchReceipt,
  LaunchRequest,
  RetryOutcome,
  RetryRequest,
  ServicePorts,
} from "./ports";

/** A throwaway world: a catalog root, a service state root, and a cleanup. */
export interface World {
  catalogRoot: string;
  requestsRoot: string;
  dispose: () => void;
}

export function makeWorld(): World {
  const root = mkdtempSync(join(tmpdir(), "odu-service-"));
  return {
    catalogRoot: join(root, "runs"),
    requestsRoot: join(root, "service"),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

const SCOPE: RunScope = { selectors: [], platforms: [], noDeps: false };

/** Register a run the way a coordinator does, and hand back its writer. */
export function registerFixtureRun(
  world: World,
  opts: {
    repoRoot: string;
    sha: string;
    seq?: number | null;
    branch?: string;
    runId?: string;
    endpoint?: string;
    now?: number;
    scope?: RunScope;
    parentRunId?: string | null;
  },
): { handle: RunHandle; token: OwnershipToken; runId: string } {
  const now = opts.now ?? Date.now();
  const runId = opts.runId ?? mintRunId(now);
  const registered = registerRun(
    {
      runId,
      repo: null,
      sha: opts.sha,
      seq: opts.seq === undefined ? 1 : opts.seq,
      pipeline: "default",
      repoRoot: opts.repoRoot,
      createdAt: now,
      scope: opts.scope ?? SCOPE,
      snapshot: {
        mode: "strict",
        expectedSha: opts.sha,
        dirty: false,
        retryable: true,
      },
      build: { oduVersion: "0.0.0", self: null, runnerFlake: null },
      parentRunId: opts.parentRunId ?? null,
      requestId: null,
      ...(opts.branch === undefined ? {} : { branch: opts.branch }),
    },
    {
      root: world.catalogRoot,
      endpoint: opts.endpoint ?? join(opts.repoRoot, ".ci", "odu.sock"),
      now,
    },
  );
  if (!registered.ok) throw new Error(`fixture: could not register ${runId}`);
  return { handle: registered.handle, token: registered.token, runId };
}

/**
 * Write one node's whole life: started, output, sealed at a status.
 *
 * The journal and the attempt store are written in the coordinator's own order
 * — `attempt_started`, then the log, then `node_status`, then `log_finalized` —
 * because the attention fold reads exactly that ordering and a fixture that
 * wrote it differently would be testing a shape nothing produces.
 */
export function writeNode(
  world: World,
  handle: RunHandle,
  token: OwnershipToken,
  node: {
    id: string;
    attempt?: number;
    status: "ok" | "failed" | "errored" | "cancelled";
    exitCode?: number | null;
    host?: string | null;
    log?: string;
    complete?: boolean;
    at?: number;
  },
): void {
  const attempt = node.attempt ?? 1;
  const at = node.at ?? Date.now();
  const platform = node.id.slice(node.id.lastIndexOf("@") + 1);
  const placement = { platform, host: node.host ?? "localhost" };
  const journal = openJournal(handle, token);
  journal.append({ kind: "attempt_started", node: node.id, attempt, placement }, at);
  startAttempt(handle, token, { node: node.id, attempt, placement, startedAt: at });
  const text = node.log ?? "";
  writeAttemptLog(handle, node.id, attempt, text);
  journal.append(
    {
      kind: "node_status",
      node: node.id,
      attempt,
      status: node.status,
      exitCode: node.exitCode ?? (node.status === "ok" ? 0 : 1),
      durationMs: 5,
      placement,
    },
    at + 5,
  );
  journal.append(
    {
      kind: "log_finalized",
      node: node.id,
      attempt,
      complete: node.complete ?? true,
      bytes: Buffer.byteLength(text),
      reason: null,
    },
    at + 6,
  );
  sealAttempt(handle, token, node.id, attempt, {
    endedAt: at + 5,
    status: node.status,
    exitCode: node.exitCode ?? (node.status === "ok" ? 0 : 1),
    signal: null,
    logComplete: node.complete ?? true,
    logTruncationReason: null,
  });
}

/** Publish a roster, which is what makes "is this settled" answerable. */
export function writeRoster(
  handle: RunHandle,
  token: OwnershipToken,
  order: readonly string[],
  at: number = Date.now(),
): void {
  appendEvent(handle, token, { kind: "roster", order: [...order] }, at);
}

/** Finalize a run the way `finalize` does — the journal line AND the verdict,
 *  because a reader that trusted only one of them is exactly the bug the
 *  catalog's own `resumedSinceFinal` exists to prevent. */
export function finalizeRun(
  handle: RunHandle,
  token: OwnershipToken,
  outcome: "passed" | "failed" | "incomplete",
  failed: readonly string[] = [],
  at: number = Date.now(),
): void {
  appendEvent(handle, token, { kind: "finalized", outcome }, at);
  writeVerdict(handle, token, {
    runId: handle.runId,
    outcome,
    startedAt: at - 100,
    finishedAt: at,
    failed: [...failed],
    errored: [],
    cancelled: [],
    unposted: [],
  });
}

/** Ports that record rather than act. */
export interface RecordingPorts extends ServicePorts {
  launches: LaunchRequest[];
  retries: RetryRequest[];
  cancels: { endpoint: string; scope: unknown }[];
}

export function recordingPorts(opts: {
  checkout?: (path: string) => CheckoutFacts;
  launch?: (request: LaunchRequest) => LaunchReceipt;
  retry?: (request: RetryRequest) => RetryOutcome;
  cancelOk?: boolean;
} = {}): RecordingPorts {
  const launches: LaunchRequest[] = [];
  const retries: RetryRequest[] = [];
  const cancels: { endpoint: string; scope: unknown }[] = [];
  return {
    launches,
    retries,
    cancels,
    launch: async (request) => {
      launches.push(request);
      return (
        opts.launch?.(request) ?? {
          ok: true,
          runId: request.runId,
          endpoint: join(request.checkout, ".ci", "odu.sock"),
          lifetime: "a stub launcher started nothing",
        }
      );
    },
    retry: async (request) => {
      retries.push(request);
      return (
        opts.retry?.(request) ?? {
          ok: true,
          replayed: false,
          receipt: {
            request_id: request.requestId ?? null,
            mode: "live",
            effective_run: request.runId,
            parent_run: null,
            roots: [request.selector],
            reset_dependants: [],
            attempts: [{ node: request.selector, attempt: 2 }],
            scope: SCOPE,
            sha: "0".repeat(40),
            cursor: `${request.runId}@0`,
          },
        }
      );
    },
    cancel: async ({ endpoint, scope }) => {
      cancels.push({ endpoint, scope });
      return opts.cancelOk === false
        ? { ok: false, detail: "the stub declined" }
        : { ok: true, detail: null };
    },
    probeCheckout: (path) =>
      opts.checkout?.(path) ?? {
        isRepo: true,
        head: "a".repeat(40),
        branch: "main",
        liveRunId: null,
      },
  };
}
