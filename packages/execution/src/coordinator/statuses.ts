/**
 * GitHub commit statuses — byte-compatible with what justci posted, so
 * kolu's branch protection is satisfied without touching its required
 * contexts (decomposed from live API data on merged PRs):
 *
 *   context      ci::<recipe>@<platform>     (setup: _ci-setup@<platform>)
 *   description  Running: <log> | Succeeded (<dur>): <log> | Failed (<dur>): <log>
 *   log path     .ci/<sha7>/<platform>/<context-prefix>.log
 *   target_url   never set
 */

import { logPathFor } from "@odu/run-client/nodeId";
import {
  type GithubState,
  type NodeStatus,
  type OwedStatus,
  type PostingHealth,
  EMPTY_POSTING,
  STATUS_META,
} from "@odu/run-client/surface";
import { formatGoDuration } from "../common/duration";
import {
  DEFAULT_GH_TIMEOUT_MS,
  type Forge,
  type ForgeResult,
  type RemoteStatus,
  type StatusPayload,
} from "../common/forge";
import { projectUnposted, type UnpostedEntry } from "@odu/run-history/legacy/record";

export type { GithubState, OwedStatus, PostingHealth, UnpostedEntry };

const GITHUB_STATES = new Set<string>([
  "pending",
  "success",
  "failure",
  "error",
]);

function isGithubState(state: string): state is GithubState {
  return GITHUB_STATES.has(state);
}

export const DEFAULT_DEBOUNCE_MS = 1_500;
export const DEFAULT_BACKOFF_BASE_MS = 5_000;
export const DEFAULT_BACKOFF_CAP_MS = 60_000;

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
  const state = STATUS_META[status].github;
  if (state === null) return null;
  const log = logPathFor(sha7, nodeId);
  const dur = formatGoDuration(durationMs ?? 0);
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
    return { state, context: nodeId, description: `${status}: ${log}` };
  }
  return {
    state,
    context: nodeId,
    description: format(dur, log),
  };
}

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

export interface StatusPosterOptions {
  owner: string;
  repo: string;
  sha: string;
  enabled: boolean;
  onLine: (line: string) => void;
  onHealth?: (health: PostingHealth) => void;
  forge: Forge;
  debounceMs?: number;
  timeoutMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

interface ContextPost {
  desired?: StatusPayload;
  confirmed?: StatusPayload;
  inFlight?: StatusPayload;
  lastError?: string;
  attempts: number;
  wake?: ReturnType<typeof setTimeout>;
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

  private owedDesired(post: ContextPost): StatusPayload | undefined {
    const d = post.desired;
    if (d === undefined) return undefined;
    if (post.confirmed !== undefined && payloadEqual(post.confirmed, d)) {
      return undefined;
    }
    return d;
  }

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

  private settleDesired(context: string, post: ContextPost): void {
    post.desired = undefined;
    this.clearDebt(post);
    this.clearWake(post);
    this.prune(context, post);
    this.emitHealth();
  }

  private ensureWake(context: string, post: ContextPost): void {
    if (post.wake !== undefined) return;
    const phase = this.currentPhase();
    if (phase === "closed") return;
    if (phase === "finalizing") this.enqueue(context);
    else this.scheduleDebounce(context);
  }

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

  unposted(): UnpostedEntry[] {
    return projectUnposted(this.health().owed);
  }

  /**
   * Only real GitHub states (`pending|success|failure|error`) are accepted —
   * unknown/empty remote `state` values are skipped rather than cast into
   * {@link StatusPayload}. Seed never marks a context `owned`: foreign pending
   * checks stay for dedup only and are excluded from interrupt error posts.
   */
  async seed(): Promise<void> {
    if (!this.opts.enabled) return;
    try {
      const listed = await this.opts.forge.listStatuses({
        owner: this.opts.owner,
        repo: this.opts.repo,
        sha: this.opts.sha,
      });
      if (!listed.ok) throw new Error(listed.error);
      // GitHub returns newest-first; keep the first sighting per context.
      const seen = new Set<string>();
      let seeded = 0;
      for (const s of listed.value) {
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

  private dropStaleNonTerminalDesired(
    context: string,
    post: ContextPost,
    payload: StatusPayload,
  ): void {
    const stale = post.desired;
    if (stale === undefined) return;
    if (!payloadEqual(stale, payload) && stale.state !== "pending") return;
    this.settleDesired(context, post);
  }

  post(payload: StatusPayload): void {
    if (!this.opts.enabled || this.phase === "closed") return;
    const post = this.entry(payload.context);
    post.owned = true;
    if (
      post.inFlight === undefined &&
      post.confirmed !== undefined &&
      payloadEqual(post.confirmed, payload)
    ) {
      this.dropStaleNonTerminalDesired(payload.context, post, payload);
      return;
    }
    post.desired = payload;
    this.emitHealth();
    if (this.phase === "finalizing") {
      this.clearWake(post);
      this.enqueue(payload.context);
      return;
    }
    this.scheduleDebounce(payload.context);
  }

  /**
   * Contexts this run owns that are still `pending` (desired and/or confirmed)
   * — the interrupt finalizer's worklist for posting `error`.
   */
  pendingContexts(): string[] {
    if (!this.opts.enabled) return [];
    const out = new Set<string>();
    for (const [context, post] of this.posts) {
      if (!post.owned) continue;
      if (post.desired?.state === "pending") out.add(context);
      if (post.confirmed?.state !== "pending") continue;
      const d = post.desired;
      if (d === undefined || d.state === "pending") out.add(context);
    }
    return [...out];
  }

  async finalize(): Promise<UnpostedEntry[]> {
    if (!this.opts.enabled) return [];
    this.phase = "finalizing";
    for (const [context, post] of this.posts) {
      if (post.wake !== undefined) {
        this.clearWake(post);
        this.enqueue(context);
      }
    }
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
      if (post.desired !== undefined) this.settleDesired(context, post);
      return;
    }

    post.inFlight = payload;
    const result = await this.send(payload);
    post.inFlight = undefined;
    if (result.ok) post.confirmed = payload;
    if (this.currentPhase() === "closed") return;

    const still = post.desired;
    const desiredMoved =
      still !== undefined && !payloadEqual(still, payload);

    if (result.ok) {
      if (!desiredMoved) {
        this.settleDesired(context, post);
        return;
      }
      this.emitHealth();
      this.ensureWake(context, post);
      return;
    }

    if (desiredMoved) {
      this.ensureWake(context, post);
      return;
    }

    post.attempts += 1;
    post.lastError = result.error;
    this.opts.onLine(
      `[odu] status post failed for ${context} (attempt ${post.attempts}): ${result.error.trim()}`,
    );
    this.emitHealth();

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

  private send(payload: StatusPayload): Promise<ForgeResult> {
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
    return withTimeout(
      this.opts.forge.postStatus({
        owner: this.opts.owner,
        repo: this.opts.repo,
        sha: this.opts.sha,
        payload,
      }),
      timeoutMs,
      `gh timed out after ${timeoutMs}ms`,
    );
  }
}

function attemptMark(payload: StatusPayload): string {
  return `${payload.context}\0${payload.state}\0${payload.description}`;
}

function withTimeout<T extends ForgeResult>(
  attempt: Promise<T>,
  timeoutMs: number,
  error: string,
): Promise<ForgeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: ForgeResult): void => {
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

export function repoSlug(gh: { owner: string; repo: string }): string {
  return `${gh.owner}/${gh.repo}`;
}

export function fetchUrlFor(url: string): string {
  const gh = parseGithubRemote(url);
  if (gh === null) return url.trim();
  return `https://github.com/${gh.owner}/${gh.repo}`;
}

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
