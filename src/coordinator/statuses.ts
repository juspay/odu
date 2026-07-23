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
 * Dedup is confirm-then-record: `lastPosted` updates only after a successful
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
  type PostingHealth,
  EMPTY_POSTING,
  STATUS_META,
} from "../common/surface";

export type { GithubState, PostingHealth };
export { EMPTY_POSTING };

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
  const description =
    status === "running"
      ? `Running: ${log}`
      : status === "ok"
        ? `Succeeded (${dur}): ${log}`
        : status === "failed"
          ? `Failed (${dur}): ${log}`
          : `Errored (${dur}): ${log}`;
  return { state, context: nodeId, description };
}

function payloadKey(payload: StatusPayload): string {
  return `${payload.state}\0${payload.description}`;
}

/** One context that still needs a confirmed post (durable run-record field). */
export interface UnpostedEntry {
  context: string;
  lastError: string;
}

/** Result of one `gh api` attempt. */
export type GhSendResult =
  | { ok: true }
  | { ok: false; error: string };

/** One remote status as returned by GET …/statuses/{sha}. */
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
  /** Injected for tests; defaults to paginated GET of commit statuses. */
  listStatuses?: () => Promise<RemoteStatus[]>;
  debounceMs?: number;
  timeoutMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

export class StatusPoster {
  /** Confirmed posts only — written on successful send, never at enqueue. */
  private readonly lastPosted = new Map<string, string>();
  private readonly lastError = new Map<string, string>();
  private readonly attempts = new Map<string, number>();
  /** Latest desired payload per context (coalesces rapid flips). */
  private readonly desired = new Map<string, StatusPayload>();
  private readonly debounceTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly backoffTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private queue: Promise<void> = Promise.resolve();
  /** After finalize completes: reject new posts; no more sends. */
  private closed = false;
  /** During finalize: accept posts but enqueue immediately (no debounce/backoff). */
  private finalizing = false;

  constructor(private readonly opts: StatusPosterOptions) {}

  /** Current posting health for the live surface. */
  health(): PostingHealth {
    if (!this.opts.enabled) return EMPTY_POSTING;
    const owed: PostingHealth["owed"] = [];
    for (const [context, payload] of this.desired) {
      if (this.lastPosted.get(context) === payloadKey(payload)) continue;
      owed.push({
        context,
        lastError: this.lastError.get(context) ?? null,
        attempts: this.attempts.get(context) ?? 0,
      });
    }
    return {
      owed,
      state: owed.length === 0 ? "ok" : "degraded",
    };
  }

  /** Durable form of still-unconfirmed contexts (empty when healthy). */
  unposted(): UnpostedEntry[] {
    return this.health().owed.map((o) => ({
      context: o.context,
      lastError: o.lastError ?? "not posted",
    }));
  }

  /**
   * Seed `lastPosted` from GitHub's current statuses for this SHA so a restart
   * does not re-post contexts already showing the desired state (eliminates the
   * "pending wave" of ~N writes on coordinator start).
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
      for (const s of list) {
        if (seen.has(s.context)) continue;
        seen.add(s.context);
        if (s.state === "" || s.context === "") continue;
        this.lastPosted.set(
          s.context,
          `${s.state}\0${s.description ?? ""}`,
        );
      }
      this.opts.onLine(
        `[odu] seeded ${seen.size} commit status(es) from GitHub`,
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
    if (!this.opts.enabled || this.closed) return;
    const key = payloadKey(payload);
    if (this.lastPosted.get(payload.context) === key) {
      // Incoming matches confirmed — only clear debt when desired is absent or
      // the *same* key. A newer different desired must not be discarded
      // (e.g. seed success, then failure still in debounce, then success re-post).
      const existing = this.desired.get(payload.context);
      if (existing === undefined || payloadKey(existing) === key) {
        if (existing !== undefined) {
          this.desired.delete(payload.context);
          this.clearDebt(payload.context);
          this.cancelTimers(payload.context);
          this.emitHealth();
        }
      }
      return;
    }
    this.desired.set(payload.context, payload);
    this.emitHealth();
    if (this.finalizing) {
      // Final drain: skip debounce so interrupt transitions still get an attempt.
      this.cancelTimers(payload.context);
      this.enqueue(payload.context);
      return;
    }
    this.scheduleDebounce(payload.context);
  }

  /**
   * Contexts whose confirmed post is still `pending` (or desired is still
   * pending) — the interrupt finalizer's worklist for posting `error`.
   * Extended from "last post was pending" to "confirmed ≠ terminal desired":
   * a context that never confirmed, or only confirmed running, is owed.
   */
  pendingContexts(): string[] {
    if (!this.opts.enabled) return [];
    const out = new Set<string>();
    for (const [context, payload] of this.desired) {
      if (payload.state === "pending") out.add(context);
    }
    for (const [context, key] of this.lastPosted) {
      if (!key.startsWith("pending\0")) continue;
      const d = this.desired.get(context);
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
    this.finalizing = true;
    // Cancel pending backoffs/debounces — enqueue immediate final attempts.
    for (const t of this.backoffTimers.values()) clearTimeout(t);
    this.backoffTimers.clear();
    for (const [context, t] of this.debounceTimers) {
      clearTimeout(t);
      this.debounceTimers.delete(context);
      this.enqueue(context);
    }
    // Drain loop: posts that arrive mid-drain (finalizing mode) chain onto
    // `this.queue`; re-await until a pass adds no new work. Each (context,key)
    // gets one final attempt — failures are not re-queued here.
    const attempted = new Set<string>();
    for (let pass = 0; pass < 32; pass++) {
      for (const context of this.desired.keys()) {
        const d = this.desired.get(context);
        if (d === undefined) continue;
        const key = payloadKey(d);
        if (this.lastPosted.get(context) === key) continue;
        const mark = `${context}\0${key}`;
        if (attempted.has(mark)) continue;
        attempted.add(mark);
        this.enqueue(context);
      }
      const q = this.queue;
      await q;
      if (this.queue === q) break;
    }
    this.closed = true;
    this.finalizing = false;
    for (const t of this.backoffTimers.values()) clearTimeout(t);
    this.backoffTimers.clear();
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    return this.unposted();
  }

  /** Wait for the post queue to drain (call before process exit). Prefer
   *  {@link finalize} when ending a run so owed posts get a last attempt. */
  settle(): Promise<void> {
    return this.queue;
  }

  private cancelTimers(context: string): void {
    const d = this.debounceTimers.get(context);
    if (d !== undefined) {
      clearTimeout(d);
      this.debounceTimers.delete(context);
    }
    const b = this.backoffTimers.get(context);
    if (b !== undefined) {
      clearTimeout(b);
      this.backoffTimers.delete(context);
    }
  }

  private scheduleDebounce(context: string): void {
    this.cancelTimers(context);
    const ms = this.opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    if (ms <= 0) {
      this.enqueue(context);
      return;
    }
    const t = setTimeout(() => {
      this.debounceTimers.delete(context);
      if (!this.closed) this.enqueue(context);
    }, ms);
    t.unref?.();
    this.debounceTimers.set(context, t);
  }

  private enqueue(context: string): void {
    this.queue = this.queue.then(() => this.sendLatest(context));
  }

  private async sendLatest(context: string): Promise<void> {
    if (this.closed) return;
    const payload = this.desired.get(context);
    if (payload === undefined) return;
    const key = payloadKey(payload);
    if (this.lastPosted.get(context) === key) {
      this.desired.delete(context);
      this.clearDebt(context);
      this.emitHealth();
      return;
    }

    const result = await this.sendWithTimeout(payload);
    if (this.closed) return;

    // Desired may have changed while the request was in flight.
    const still = this.desired.get(context);
    if (still !== undefined && payloadKey(still) !== key) {
      return;
    }

    if (result.ok) {
      this.lastPosted.set(context, key);
      this.desired.delete(context);
      this.clearDebt(context);
      this.emitHealth();
      return;
    }

    const n = (this.attempts.get(context) ?? 0) + 1;
    this.attempts.set(context, n);
    this.lastError.set(context, result.error);
    this.opts.onLine(
      `[odu] status post failed for ${context} (attempt ${n}): ${result.error.trim()}`,
    );
    this.emitHealth();

    // No infinite retry during finalize — one final attempt, then record debt.
    if (this.closed || this.finalizing) return;

    const base = this.opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const cap = this.opts.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
    const delay = Math.min(base * 2 ** (n - 1), cap);
    const t = setTimeout(() => {
      this.backoffTimers.delete(context);
      if (!this.closed && !this.finalizing) this.enqueue(context);
    }, delay);
    t.unref?.();
    this.backoffTimers.set(context, t);
  }

  private clearDebt(context: string): void {
    this.lastError.delete(context);
    this.attempts.delete(context);
  }

  private emitHealth(): void {
    this.opts.onHealth?.(this.health());
  }

  /** Run one send under the hang-timeout so a stuck `gh` can't wedge the queue. */
  private sendWithTimeout(payload: StatusPayload): Promise<GhSendResult> {
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
    const attempt =
      this.opts.sendGh !== undefined
        ? this.opts.sendGh(payload)
        : defaultSendGh(this.opts, payload);
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: GhSendResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const timer = setTimeout(() => {
        done({ ok: false, error: `gh timed out after ${timeoutMs}ms` });
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
}

/** Spawn `gh api` POST for one status; kill after timeout. */
function defaultSendGh(
  opts: StatusPosterOptions,
  payload: StatusPayload,
): Promise<GhSendResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
  return new Promise((resolve) => {
    const gh = process.env.ODU_GH_BIN ?? "gh";
    const child = spawn(
      gh,
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
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    let settled = false;
    const done = (result: GhSendResult): void => {
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
      if (code === 0) done({ ok: true });
      else done({ ok: false, error: stderr.trim() || `gh exited ${code}` });
    });
  });
}

/**
 * Parse `gh api --paginate` stdout. Multi-page responses concatenate JSON
 * values (`[{…}][{…}]`); a single page is one JSON value. Exported for tests.
 */
export function parseGhPaginatedStdout(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  // Fast path: one JSON value (array or object).
  try {
    const once: unknown = JSON.parse(trimmed);
    return Array.isArray(once) ? once : [once];
  } catch {
    // Multi-page: split concatenated top-level JSON values.
  }
  const items: unknown[] = [];
  let i = 0;
  const s = trimmed;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i] ?? "")) i += 1;
    if (i >= s.length) break;
    const start = i;
    const open = s[i];
    if (open !== "[" && open !== "{") {
      throw new Error(
        `unexpected gh paginate token at ${i}: ${s.slice(i, i + 20)}`,
      );
    }
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    let inString = false;
    let escape = false;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === "\\") escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
    }
    const chunk = s.slice(start, i);
    const parsed: unknown = JSON.parse(chunk);
    if (Array.isArray(parsed)) items.push(...parsed);
    else items.push(parsed);
  }
  return items;
}

function remoteStatusesFromItems(items: unknown[]): RemoteStatus[] {
  const out: RemoteStatus[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    // Combined status endpoint wraps latest-per-context in `.statuses`.
    if (Array.isArray(rec.statuses)) {
      out.push(...remoteStatusesFromItems(rec.statuses));
      continue;
    }
    const context = typeof rec.context === "string" ? rec.context : "";
    const state = typeof rec.state === "string" ? rec.state : "";
    const description =
      typeof rec.description === "string" ? rec.description : "";
    if (context !== "") out.push({ context, state, description });
  }
  return out;
}

/**
 * Seed source: combined commit status (latest per context in one response).
 * Falls back to paginated `…/statuses/{sha}` if the combined endpoint fails.
 * Both paths hang-timeout like POST.
 */
async function defaultListStatuses(
  opts: StatusPosterOptions,
): Promise<RemoteStatus[]> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
  const combined = await ghApiGet(
    `repos/${opts.owner}/${opts.repo}/commits/${opts.sha}/status`,
    timeoutMs,
  );
  if (combined.ok) {
    return remoteStatusesFromItems(parseGhPaginatedStdout(combined.stdout));
  }
  // Fallback: full status history (newest-first); first sighting per context wins.
  const listed = await ghApiGet(
    `repos/${opts.owner}/${opts.repo}/statuses/${opts.sha}?per_page=100`,
    timeoutMs,
    { paginate: true },
  );
  if (!listed.ok) {
    throw new Error(listed.error);
  }
  return remoteStatusesFromItems(parseGhPaginatedStdout(listed.stdout));
}

/** Spawn `gh api` GET; kill after timeout. */
function ghApiGet(
  path: string,
  timeoutMs: number,
  opts: { paginate?: boolean } = {},
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  const gh = process.env.ODU_GH_BIN ?? "gh";
  const args = opts.paginate ? ["api", "--paginate", path] : ["api", path];
  return new Promise((resolve) => {
    const child = spawn(gh, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf-8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf-8");
    });
    let settled = false;
    const done = (
      result: { ok: true; stdout: string } | { ok: false; error: string },
    ): void => {
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
      if (code === 0) done({ ok: true, stdout });
      else done({ ok: false, error: stderr.trim() || `gh exited ${code}` });
    });
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

/** Human warning strip for attach/status while posts are owed. */
export function postingWarning(health: PostingHealth): string | null {
  if (health.state === "ok" || health.owed.length === 0) return null;
  const n = health.owed.length;
  const last =
    health.owed.map((o) => o.lastError).find((e) => e !== null && e !== "") ??
    null;
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
  if (left.state !== b.state || left.owed.length !== b.owed.length) return false;
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
