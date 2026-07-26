/**
 * GitHub commit statuses — byte-compatible with what justci posted, so
 * kolu's branch protection is satisfied without touching its required
 * contexts (decomposed from live API data on merged PRs):
 *
 *   context      ci::<recipe>@<platform>     (setup: _ci-setup@<platform>)
 *   description  Running: <log> | Succeeded (<dur>): <log> | Failed (<dur>): <log>
 *   log path     .ci/<sha7>/<platform>/<context-prefix>.log
 *   target_url   never set
 *
 * `Errored (<dur>): <log>` (GitHub state `error`) is odu's own addition for
 * infrastructure death — justci's wording for that case was never observed
 * in the wild, so this is a decision, not parity.
 *
 * Posts go through `gh api` (the `$ODU_GH_BIN` override is baked to the
 * pinned gh in the nix wrapper) from the coordinator only — lane hosts never
 * see credentials. Posting is diff-driven off the fan-in state: after any
 * gap, the next snapshot re-derives exactly the transitions that were
 * missed.
 *
 * Dedup is confirm-then-record: `confirmed` updates only after a successful
 * `gh api`, so a failed send is re-derived and retried. Transient failures
 * retry with exponential backoff for the life of the run; the `gh` child is
 * killed after a timeout so one hung TCP can't wedge the post queue.
 */

import { spawn } from "node:child_process";
import { formatGoDuration } from "../common/duration";
import { splitFanId } from "../common/nodeId";
import {
  type GithubState,
  type NodeStatus,
  type OwedStatus,
  type PostingHealth,
  type UnpostedEntry,
  EMPTY_POSTING,
  projectUnposted,
  STATUS_META,
} from "../common/surface";

export type { GithubState, OwedStatus, PostingHealth, UnpostedEntry };

/** GitHub commit-status `state` values the statuses API accepts. */
const GITHUB_STATES = new Set<string>([
  "pending",
  "success",
  "failure",
  "error",
]);

function isGithubState(state: string): state is GithubState {
  return GITHUB_STATES.has(state);
}

/** Default debounce: rapid pending→failed→pending flips collapse to latest. */
export const DEFAULT_DEBOUNCE_MS = 1_500;
/** Kill a hung `gh api` so it can't wedge the serialized post queue. */
export const DEFAULT_GH_TIMEOUT_MS = 30_000;
/** First backoff after a failed send; doubles per attempt, capped. */
export const DEFAULT_BACKOFF_BASE_MS = 5_000;
export const DEFAULT_BACKOFF_CAP_MS = 60_000;

/** `ci::e2e@x86_64-linux` → `.ci/<sha7>/x86_64-linux/ci::e2e.log` */
export function logPathFor(sha7: string, nodeId: string): string {
  const { namepath, platform } = splitFanId(nodeId);
  return `.ci/${sha7}/${platform}/${namepath}.log`;
}

export interface StatusPayload {
  state: GithubState;
  context: string;
  description: string;
}

/** Pure structural equality for status payloads. */
export function payloadEqual(a: StatusPayload, b: StatusPayload): boolean {
  return (
    a.state === b.state &&
    a.context === b.context &&
    a.description === b.description
  );
}

/** The status to post for a node transition; `null` = nothing to post
 *  (pending resets and skips post nothing — a skipped required context stays
 *  absent and correctly blocks the merge, as observed under justci). */
export function statusFor(
  nodeId: string,
  status: NodeStatus,
  durationMs: number | null,
  sha7: string,
): StatusPayload | null {
  // The state + the post/no-post decision come from the shared projection;
  // only the justci wording (with duration) is assembled locally.
  const state = STATUS_META[status].github;
  if (state === null) return null;
  const log = logPathFor(sha7, nodeId);
  const dur = formatGoDuration(durationMs ?? 0);
  // justci wording for posts that fire — keyed by status so a new NodeStatus
  // is one table row, not another nest of ternaries.
  const descriptions: Partial<
    Record<NodeStatus, (d: string, l: string) => string>
  > = {
    running: (_d, l) => `Running: ${l}`,
    ok: (d, l) => `Succeeded (${d}): ${l}`,
    failed: (d, l) => `Failed (${d}): ${l}`,
    cancelled: (d, l) => `Cancelled (${d}): ${l}`,
    errored: (d, l) => `Errored (${d}): ${l}`,
  };
  const format = descriptions[status];
  if (format === undefined) {
    // Defensive: github non-null should only land for statuses in the table.
    return { state, context: nodeId, description: `${status}: ${log}` };
  }
  return {
    state,
    context: nodeId,
    description: format(dur, log),
  };
}

/**
 * Interrupt/error status wording — the one projector for cancel/SIGINT/idle
 * `error` posts so descriptions never bypass the statuses surface (Lowy #11).
 */
export function interruptStatus(
  context: string,
  reason: string,
  sha7: string,
): StatusPayload {
  return {
    state: "error",
    context,
    description: `Errored (${reason}): ${logPathFor(sha7, context)}`,
  };
}

/** Result of one `gh api` attempt. */
export type GhSendResult =
  | { ok: true }
  | { ok: false; error: string };

/** One remote status as returned by GET …/commits/{sha}/status. */
export interface RemoteStatus {
  context: string;
  state: string;
  description: string;
}

export interface StatusPosterOptions {
  owner: string;
  repo: string;
  sha: string;
  enabled: boolean;
  onLine: (line: string) => void;
  /** Fired whenever posting health changes (owed set / last error / attempts). */
  onHealth?: (health: PostingHealth) => void;
  /** Injected for tests; defaults to spawning `gh api` with a timeout. */
  sendGh?: (payload: StatusPayload) => Promise<GhSendResult>;
  /** Injected for tests; defaults to paginated GET …/statuses/{sha}. */
  listStatuses?: () => Promise<RemoteStatus[]>;
  debounceMs?: number;
  timeoutMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

/** Per-context posting state — one map entry owns desired/confirmed/debt/wake. */
interface ContextPost {
  desired?: StatusPayload;
  confirmed?: StatusPayload;
  lastError?: string;
  attempts: number;
  /** Single wake timer: debounce before first send, or backoff after failure. */
  wake?: ReturnType<typeof setTimeout>;
  /**
   * True once this run has called {@link StatusPoster.post} for the context.
   * Seed alone does not set it — foreign GitHub contexts (Actions, other bots)
   * stay in `confirmed` for dedup but must not enter the interrupt worklist.
   */
  owned: boolean;
}

type PosterPhase = "open" | "finalizing" | "closed";

export class StatusPoster {
  private readonly posts = new Map<string, ContextPost>();
  private queue: Promise<void> = Promise.resolve();
  private phase: PosterPhase = "open";

  constructor(private readonly opts: StatusPosterOptions) {}

  private currentPhase(): PosterPhase {
    return this.phase;
  }

  private entry(context: string): ContextPost {
    let post = this.posts.get(context);
    if (post === undefined) {
      post = { attempts: 0, owned: false };
      this.posts.set(context, post);
    }
    return post;
  }

  private clearWake(post: ContextPost): void {
    if (post.wake !== undefined) {
      clearTimeout(post.wake);
      post.wake = undefined;
    }
  }

  private clearDebt(post: ContextPost): void {
    post.lastError = undefined;
    post.attempts = 0;
  }

  /** Desired payload still needing a confirmed send, or `undefined` if settled. */
  private owedDesired(post: ContextPost): StatusPayload | undefined {
    const d = post.desired;
    if (d === undefined) return undefined;
    if (post.confirmed !== undefined && payloadEqual(post.confirmed, d)) {
      return undefined;
    }
    return d;
  }

  /** Drop a post entry when it holds nothing useful. */
  private prune(context: string, post: ContextPost): void {
    if (
      post.desired === undefined &&
      post.confirmed === undefined &&
      post.wake === undefined &&
      post.attempts === 0 &&
      post.lastError === undefined &&
      !post.owned
    ) {
      this.posts.delete(context);
    }
  }

  /** Clear desired + debt after a confirmed match; emit health. */
  private settleDesired(context: string, post: ContextPost): void {
    post.desired = undefined;
    this.clearDebt(post);
    this.clearWake(post);
    this.prune(context, post);
    this.emitHealth();
  }

  /**
   * Schedule a follow-up send when desired moved mid-flight and no wake is armed.
   * Debounce while open; immediate enqueue while finalizing.
   */
  private ensureWake(context: string, post: ContextPost): void {
    if (post.wake !== undefined) return;
    const phase = this.currentPhase();
    if (phase === "closed") return;
    if (phase === "finalizing") this.enqueue(context);
    else this.scheduleDebounce(context);
  }

  /** Current posting health for the live surface. */
  health(): PostingHealth {
    if (!this.opts.enabled) return EMPTY_POSTING;
    const owed: OwedStatus[] = [];
    for (const [context, post] of this.posts) {
      if (this.owedDesired(post) === undefined) continue;
      owed.push({
        context,
        lastError: post.lastError ?? null,
        attempts: post.attempts,
      });
    }
    return { owed };
  }

  /** Durable form of still-unconfirmed contexts (empty when healthy). */
  unposted(): UnpostedEntry[] {
    return projectUnposted(this.health().owed);
  }

  /**
   * Seed `confirmed` from GitHub's statuses for this SHA so a restart does not
   * re-post contexts already showing the desired state (eliminates the
   * "pending wave" of ~N writes on coordinator start). Soft-fails to an empty
   * seed on any list error.
   *
   * Only real GitHub states (`pending|success|failure|error`) are accepted —
   * unknown/empty remote `state` values are skipped rather than cast into
   * {@link StatusPayload}. Seed never marks a context `owned`: foreign pending
   * checks stay for dedup only and are excluded from interrupt error posts.
   */
  async seed(): Promise<void> {
    if (!this.opts.enabled) return;
    try {
      const list =
        this.opts.listStatuses !== undefined
          ? await this.opts.listStatuses()
          : await defaultListStatuses(this.opts);
      // GitHub returns newest-first; keep the first sighting per context.
      const seen = new Set<string>();
      let seeded = 0;
      for (const s of list) {
        if (s.context === "" || seen.has(s.context)) continue;
        seen.add(s.context);
        if (!isGithubState(s.state)) continue;
        const post = this.entry(s.context);
        post.confirmed = {
          state: s.state,
          context: s.context,
          description: s.description ?? "",
        };
        seeded += 1;
      }
      this.opts.onLine(
        `[odu] seeded ${seeded} commit status(es) from GitHub`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.opts.onLine(`[odu] status seed failed (continuing): ${msg}`);
    }
  }

  /** Post the payload unless this exact (context, state, description) was the
   *  last *confirmed* post for the context. Desired state is coalesced; the
   *  actual send is debounced so rapid re-run flips collapse to the latest.
   *  During {@link finalize}, posts enqueue immediately (no debounce). */
  post(payload: StatusPayload): void {
    if (!this.opts.enabled || this.phase === "closed") return;
    const post = this.entry(payload.context);
    post.owned = true;
    if (
      post.confirmed !== undefined &&
      payloadEqual(post.confirmed, payload)
    ) {
      // Incoming matches confirmed — clear debt only when desired is the *same*
      // payload. A newer different desired must not be discarded (e.g. seed
      // success, failure still in debounce, then success re-post).
      if (post.desired !== undefined && payloadEqual(post.desired, payload)) {
        this.settleDesired(payload.context, post);
      }
      return;
    }
    post.desired = payload;
    this.emitHealth();
    if (this.phase === "finalizing") {
      // Final drain: skip debounce so interrupt transitions still get an attempt.
      this.clearWake(post);
      this.enqueue(payload.context);
      return;
    }
    this.scheduleDebounce(payload.context);
  }

  /**
   * Contexts this run owns that are still `pending` (desired and/or confirmed)
   * — the interrupt finalizer's worklist for posting `error`.
   *
   * Only {@link ContextPost.owned} contexts (this run called {@link post}) are
   * included. Seeded foreign/third-party pending checks (CI Actions, other bots)
   * must never receive an interrupt `error` POST.
   */
  pendingContexts(): string[] {
    if (!this.opts.enabled) return [];
    const out = new Set<string>();
    for (const [context, post] of this.posts) {
      if (!post.owned) continue;
      if (post.desired?.state === "pending") out.add(context);
      if (post.confirmed?.state !== "pending") continue;
      const d = post.desired;
      // Confirmed pending with no newer desired terminal, or desired still pending.
      if (d === undefined || d.state === "pending") out.add(context);
    }
    return [...out];
  }

  /**
   * Flush debounced posts, cancel backoff, make final attempts at everything
   * owed (including posts that arrive mid-drain), then stop retrying. Returns
   * contexts that still failed to post.
   */
  async finalize(): Promise<UnpostedEntry[]> {
    if (!this.opts.enabled) return [];
    this.phase = "finalizing";
    // Cancel pending backoffs/debounces — enqueue immediate final attempts.
    for (const [context, post] of this.posts) {
      if (post.wake !== undefined) {
        this.clearWake(post);
        this.enqueue(context);
      }
    }
    // Drain until the queue is stable and every current unconfirmed desired
    // has been attempted once. No fixed pass cap — bound by unique
    // (context, payload) pairs that appear as desired during the drain.
    const attempted = new Set<string>();
    for (;;) {
      for (const [context, post] of this.posts) {
        const d = this.owedDesired(post);
        if (d === undefined) continue;
        const mark = attemptMark(d);
        if (attempted.has(mark)) continue;
        attempted.add(mark);
        this.enqueue(context);
      }
      const q = this.queue;
      await q;
      if (this.queue !== q) continue;
      let more = false;
      for (const [, post] of this.posts) {
        const d = this.owedDesired(post);
        if (d !== undefined && !attempted.has(attemptMark(d))) {
          more = true;
          break;
        }
      }
      if (!more) break;
    }
    this.phase = "closed";
    for (const post of this.posts.values()) this.clearWake(post);
    return this.unposted();
  }

  /** Wait for the post queue to drain (call before process exit). Prefer
   *  {@link finalize} when ending a run so owed posts get a last attempt. */
  settle(): Promise<void> {
    return this.queue;
  }

  private scheduleDebounce(context: string): void {
    const post = this.entry(context);
    this.clearWake(post);
    const ms = this.opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    if (ms <= 0) {
      this.enqueue(context);
      return;
    }
    const t = setTimeout(() => {
      post.wake = undefined;
      if (this.phase === "open") this.enqueue(context);
    }, ms);
    t.unref?.();
    post.wake = t;
  }

  private enqueue(context: string): void {
    this.queue = this.queue.then(() => this.sendLatest(context));
  }

  private async sendLatest(context: string): Promise<void> {
    // Read via getter so control-flow narrowing does not stick across `await`
    // (phase can advance to closed while a send is in flight).
    if (this.currentPhase() === "closed") return;
    const post = this.posts.get(context);
    if (post === undefined) return;
    const payload = this.owedDesired(post);
    if (payload === undefined) {
      // Desired matches confirmed (or is absent) — drop any stale desired.
      if (post.desired !== undefined) this.settleDesired(context, post);
      return;
    }

    const result = await this.send(payload);
    if (this.currentPhase() === "closed") return;

    // Desired may have moved while the request was in flight.
    const still = post.desired;
    const desiredMoved =
      still !== undefined && !payloadEqual(still, payload);

    if (result.ok) {
      // Always record a successful send — even when desired moved mid-flight —
      // so the next comparison is against what GitHub actually has.
      post.confirmed = payload;
      if (!desiredMoved) {
        this.settleDesired(context, post);
        return;
      }
      // Keep the newer desired; arm a follow-up if post() did not already.
      this.emitHealth();
      this.ensureWake(context, post);
      return;
    }

    if (desiredMoved) {
      // Failure was about the old payload; leave debt/attempts for the new desired.
      this.ensureWake(context, post);
      return;
    }

    post.attempts += 1;
    post.lastError = result.error;
    this.opts.onLine(
      `[odu] status post failed for ${context} (attempt ${post.attempts}): ${result.error.trim()}`,
    );
    this.emitHealth();

    // No infinite retry during finalize — one final attempt, then record debt.
    if (this.currentPhase() !== "open") return;

    const base = this.opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const cap = this.opts.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
    const delay = Math.min(base * 2 ** (post.attempts - 1), cap);
    this.clearWake(post);
    const t = setTimeout(() => {
      post.wake = undefined;
      if (this.phase === "open") this.enqueue(context);
    }, delay);
    t.unref?.();
    post.wake = t;
  }

  private emitHealth(): void {
    this.opts.onHealth?.(this.health());
  }

  /**
   * One send. Default `gh` path kills the child on timeout; injected `sendGh`
   * still gets a hang-timeout so a stuck fake can't wedge the queue.
   */
  private send(payload: StatusPayload): Promise<GhSendResult> {
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
    if (this.opts.sendGh !== undefined) {
      return withTimeout(
        this.opts.sendGh(payload),
        timeoutMs,
        `gh timed out after ${timeoutMs}ms`,
      );
    }
    return defaultSendGh(this.opts, payload);
  }
}

function attemptMark(payload: StatusPayload): string {
  return `${payload.context}\0${payload.state}\0${payload.description}`;
}

/** Race a promise against a timeout; does not cancel the underlying work. */
function withTimeout<T extends GhSendResult>(
  attempt: Promise<T>,
  timeoutMs: number,
  error: string,
): Promise<GhSendResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: GhSendResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      done({ ok: false, error });
    }, timeoutMs);
    timer.unref?.();
    void attempt.then(
      (r) => done(r),
      (err: unknown) =>
        done({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
    );
  });
}

type GhRunResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; error: string };

/**
 * Spawn `gh` with kill-on-timeout. Shared by POST (status) and GET (seed).
 */
function runGh(
  args: string[],
  timeoutMs: number,
  opts: { captureStdout: boolean },
): Promise<GhRunResult> {
  const gh = process.env.ODU_GH_BIN ?? "gh";
  return new Promise((resolve) => {
    const child = spawn(gh, args, {
      stdio: ["ignore", opts.captureStdout ? "pipe" : "ignore", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    if (opts.captureStdout) {
      child.stdout?.on("data", (c: Buffer) => {
        stdout += c.toString("utf-8");
      });
    }
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf-8");
    });
    let settled = false;
    const done = (result: GhRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, error: `gh timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (err) => done({ ok: false, error: err.message }));
    child.on("close", (code) => {
      if (code === 0) done({ ok: true, stdout, stderr });
      else done({ ok: false, error: stderr.trim() || `gh exited ${code}` });
    });
  });
}

/** Spawn `gh api` POST for one status; kill after timeout. */
function defaultSendGh(
  opts: StatusPosterOptions,
  payload: StatusPayload,
): Promise<GhSendResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
  return runGh(
    [
      "api",
      `repos/${opts.owner}/${opts.repo}/statuses/${opts.sha}`,
      "-f",
      `state=${payload.state}`,
      "-f",
      `context=${payload.context}`,
      "-f",
      `description=${payload.description}`,
    ],
    timeoutMs,
    { captureStdout: false },
  ).then((r) => (r.ok ? { ok: true } : { ok: false, error: r.error }));
}

function remoteStatusFromItem(item: unknown): RemoteStatus | null {
  if (typeof item !== "object" || item === null) return null;
  const row = item as Record<string, unknown>;
  const context = typeof row.context === "string" ? row.context : "";
  const state = typeof row.state === "string" ? row.state : "";
  const description =
    typeof row.description === "string" ? row.description : "";
  if (context === "") return null;
  return { context, state, description };
}

/**
 * Seed source: paginated GET `/repos/{owner}/{repo}/statuses/{sha}` (100/page).
 * Newest-first; first sighting per context is the latest. Separate page
 * requests (no multi-page concat parser). Soft-fail empty seed on non-zero /
 * parse error is handled by {@link StatusPoster.seed}.
 */
async function defaultListStatuses(
  opts: StatusPosterOptions,
): Promise<RemoteStatus[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
  const out: RemoteStatus[] = [];
  const seen = new Set<string>();
  // Bound pages so a pathological history cannot hang seed forever.
  const maxPages = 50;
  for (let page = 1; page <= maxPages; page++) {
    const result = await runGh(
      [
        "api",
        `repos/${opts.owner}/${opts.repo}/statuses/${opts.sha}?per_page=100&page=${page}`,
      ],
      timeoutMs,
      { captureStdout: true },
    );
    if (!result.ok) throw new Error(result.error);
    const trimmed = result.stdout.trim();
    if (trimmed === "") break;
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.length === 0) break;
    for (const item of parsed) {
      const row = remoteStatusFromItem(item);
      if (row === null || seen.has(row.context)) continue;
      seen.add(row.context);
      out.push(row);
    }
    if (parsed.length < 100) break;
  }
  return out;
}

/** Parse `git remote get-url origin` output into {owner, repo} for the
 *  statuses API; understands https and ssh GitHub remotes. */
export function parseGithubRemote(
  url: string,
): { owner: string; repo: string } | null {
  const match =
    /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url.trim()) ?? null;
  if (match === null) return null;
  const [, owner, repo] = match;
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

/** Format a parsed GitHub remote as its `owner/repo` slug — the durable run
 *  record's repo identity. */
export function repoSlug(gh: { owner: string; repo: string }): string {
  return `${gh.owner}/${gh.repo}`;
}

/** Normalize a GitHub remote to the anonymous-https form lane hosts fetch
 *  from (they have no GitHub ssh identity — the repo being public is what
 *  makes remote lanes work). */
export function fetchUrlFor(url: string): string {
  const gh = parseGithubRemote(url);
  if (gh === null) return url.trim();
  return `https://github.com/${gh.owner}/${gh.repo}`;
}

/** Shared "N statuses never reached GitHub" note for verdict lines. */
export function unpostedNote(n: number): string {
  if (n <= 0) return "";
  return `, ${n} status${n === 1 ? "" : "es"} never reached GitHub`;
}

/** Human warning strip for attach/status while posts are owed. */
export function postingWarning(health: PostingHealth): string | null {
  if (health.owed.length === 0) return null;
  const n = health.owed.length;
  const last = health.owed.find((o) => o.lastError)?.lastError ?? null;
  const noun = n === 1 ? "status" : "statuses";
  const err = last !== null ? `, last error: ${last}` : "";
  // "sending" before the first attempt (debounce window); "retrying" after.
  const phase = health.owed.some((o) => o.attempts > 0) ? "retrying" : "sending";
  return `⚠ github: ${n} ${noun} unconfirmed (${phase}${err})`;
}

/** Structural equality for posting health — avoids JSON.stringify on the hot path. */
export function postingEqual(
  a: PostingHealth | undefined | null,
  b: PostingHealth,
): boolean {
  const left = a ?? EMPTY_POSTING;
  if (left.owed.length !== b.owed.length) return false;
  for (let i = 0; i < left.owed.length; i++) {
    const x = left.owed[i];
    const y = b.owed[i];
    if (x === undefined || y === undefined) return false;
    if (
      x.context !== y.context ||
      x.attempts !== y.attempts ||
      x.lastError !== y.lastError
    ) {
      return false;
    }
  }
  return true;
}
