import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join } from "node:path";
import { RUN_FILES } from "@odu/run-history/paths";
import { mintRunId } from "@odu/run-history/ids";
import {
  appendEvent,
  openJournal,
  readJournal,
  registerRun,
  type RunHandle,
  sealAttempt,
  startAttempt,
  writeVerdict,
} from "@odu/run-history/store";
import type { OwnershipToken } from "@odu/run-history/owner";
import type { RunScope } from "@odu/run-history/schema";
import type {
  CancelOutcome,
  CancelRequest,
  CheckoutFacts,
  CheckoutMoveOutcome,
  CheckoutMoveRequest,
  LaunchReceipt,
  LaunchRequest,
  RetryOutcome,
  RetryRequest,
  PushResolution,
  ServicePorts,
} from "./ports";

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

export function registerFixtureRun(
  world: World,
  opts: {
    repoRoot: string;
    sha: string;
    repo?: string | null;
    seq?: number | null;
    branch?: string;
    runId?: string;
    endpoint?: string;
    now?: number;
    scope?: RunScope;
    parentRunId?: string | null;
    actor?: string;
    push?: {
      target: { substituter: string; bucket: string; tokenId: string } | null;
      skipped: string | null;
      keyWarning: string | null;
    };
  },
): { handle: RunHandle; token: OwnershipToken; runId: string } {
  const now = opts.now ?? Date.now();
  const runId = opts.runId ?? mintRunId(now);
  const registered = registerRun(
    {
      runId,
      repo: opts.repo ?? null,
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
      ...(opts.actor === undefined ? {} : { actor: opts.actor }),
      ...(opts.push === undefined ? {} : { push: opts.push }),
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

const PID_THAT_CANNOT_EXIST = 0x7ffffff0;

export function crashOwner(
  handle: RunHandle,
  opts: { heartbeatAt: number; pid?: number },
): void {
  const path = join(handle.dir, RUN_FILES.owner);
  const owner = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        ...owner,
        pid: opts.pid ?? PID_THAT_CANNOT_EXIST,
        host: hostname(),
        heartbeatAt: opts.heartbeatAt,
      },
      null,
      2,
    )}\n`,
  );
}

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
  const sink = startAttempt(handle, token, {
    node: node.id,
    attempt,
    placement,
    startedAt: at,
  });
  const text = node.log ?? "";
  sink?.replace(text);
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

export function writeLane(
  handle: RunHandle,
  token: OwnershipToken,
  lane: {
    platform: string;
    state: "claiming" | "leased";
    host?: string | null;
    pool?: readonly string[];
    hostsSource?: string | null;
  },
  at: number = Date.now(),
): void {
  appendEvent(
    handle,
    token,
    {
      kind: "lane",
      platform: lane.platform,
      state: lane.state,
      host: lane.host ?? null,
      ...(lane.pool === undefined ? {} : { pool: [...lane.pool] }),
      ...(lane.hostsSource === undefined ? {} : { hostsSource: lane.hostsSource }),
    },
    at,
  );
}

export function writePhase(
  handle: RunHandle,
  token: OwnershipToken,
  phase: "provisioning" | "lanes" | "no_lanes",
  at: number = Date.now(),
): void {
  appendEvent(handle, token, { kind: "phase", phase }, at);
}

export function writeDebt(
  handle: RunHandle,
  token: OwnershipToken,
  debt: { context: string; lastError: string; attempts: number },
  at: number = Date.now(),
): void {
  appendEvent(handle, token, { kind: "posting_debt", ...debt }, at);
}

export function writeBulkJournal(
  handle: RunHandle,
  lines: number,
  at: number = Date.now(),
): void {
  const from = readJournal(handle).nextSeq;
  const out: string[] = [];
  for (let seq = from; seq < from + lines; seq += 1) {
    out.push(JSON.stringify({ seq, at, event: { kind: "phase", phase: "lanes" } }));
  }
  appendFileSync(join(handle.dir, RUN_FILES.events), `${out.join("\n")}\n`);
}

export function writeRoster(
  handle: RunHandle,
  token: OwnershipToken,
  order: readonly string[],
  at: number = Date.now(),
): void {
  appendEvent(handle, token, { kind: "roster", order: [...order] }, at);
}

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

export interface RecordingPorts extends ServicePorts {
  launches: LaunchRequest[];
  retries: RetryRequest[];
  cancels: CancelRequest[];
  moves: CheckoutMoveRequest[];
  probes: VenueProbeRequest[];
  holds: VenueHoldRequest[];
  releases: VenueReleaseRequest[];
  protects: ProtectRequest[];
  pushResolves: string[];
  pushGrants: { bucket: string; runId: string }[];
  pushRevokes: string[];
}

type VenueProbeRequest = Parameters<ServicePorts["probeVenues"]>[0];
type VenueHoldRequest = Parameters<ServicePorts["holdVenue"]>[0];
type VenueReleaseRequest = Parameters<ServicePorts["releaseVenue"]>[0];
type ProtectRequest = Parameters<ServicePorts["protect"]>[0];
type VenueHoldOutcome = Awaited<ReturnType<ServicePorts["holdVenue"]>>;
type VenueReleaseResult = Awaited<
  ReturnType<ServicePorts["releaseVenue"]>
>["results"][number];
type ProtectOutcome = Awaited<ReturnType<ServicePorts["protect"]>>;

export function recordingPorts(opts: {
  checkout?: (path: string) => CheckoutFacts;
  move?: (request: CheckoutMoveRequest) => CheckoutMoveOutcome;
  launch?: (request: LaunchRequest) => LaunchReceipt;
  retry?: (request: RetryRequest) => RetryOutcome;
  cancelOk?: boolean | CancelOutcome;
  hold?: (request: VenueHoldRequest) => VenueHoldOutcome;
  release?: (request: VenueReleaseRequest) => { results: readonly VenueReleaseResult[] };
  protect?: (request: ProtectRequest) => ProtectOutcome;
  push?: (checkout: string) => PushResolution;
} = {}): RecordingPorts {
  const launches: LaunchRequest[] = [];
  const retries: RetryRequest[] = [];
  const cancels: CancelRequest[] = [];
  const moves: CheckoutMoveRequest[] = [];
  const probes: VenueProbeRequest[] = [];
  const holds: VenueHoldRequest[] = [];
  const releases: VenueReleaseRequest[] = [];
  const protects: ProtectRequest[] = [];
  const pushResolves: string[] = [];
  const pushGrants: { bucket: string; runId: string }[] = [];
  const pushRevokes: string[] = [];
  return {
    launches,
    retries,
    cancels,
    moves,
    moveCheckout: async (request) => {
      moves.push(request);
      return opts.move?.(request) ?? { kind: "moved", head: request.sha };
    },
    probes,
    holds,
    releases,
    protects,
    pushResolves,
    pushGrants,
    pushRevokes,
    push: {
      resolve: async (checkout) => {
        pushResolves.push(checkout);
        return (
          opts.push?.(checkout) ?? {
            kind: "skipped",
            reason: "the stub resolves no cache",
          }
        );
      },
      grant: (request) => {
        pushGrants.push(request);
        return {
          tokenId: `tok-${pushGrants.length}`,
          token: `odu_stub_${pushGrants.length}`,
        };
      },
      revoke: (tokenId) => {
        pushRevokes.push(tokenId);
      },
    },
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
    cancel: async (request) => {
      cancels.push(request);
      if (typeof opts.cancelOk === "object") return opts.cancelOk;
      return opts.cancelOk === false
        ? { kind: "declined", detail: "the stub declined" }
        : { kind: "cancelled", detail: null };
    },
    probeCheckout: (path) =>
      opts.checkout?.(path) ?? {
        isRepo: true,
        head: "a".repeat(40),
        branch: "main",
        liveRunId: null,
      },
    pipeline: () => ({ ok: false, message: "the stub reads no pipeline" }),
    probeVenues: async (request) => {
      probes.push(request);
      return { ok: false, message: "the stub probes nothing" };
    },
    holdVenue: async (request) => {
      holds.push(request);
      return (
        opts.hold?.(request) ?? { ok: false, message: "the stub holds nothing" }
      );
    },
    releaseVenue: async (request) => {
      releases.push(request);
      return opts.release?.(request) ?? { results: [] };
    },
    protect: async (request) => {
      protects.push(request);
      return (
        opts.protect?.(request) ?? {
          ok: false,
          code: "checkout_refused",
          message: "the stub writes no rulesets",
        }
      );
    },
  };
}
