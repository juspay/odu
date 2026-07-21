/**
 * The `wait_for_settle` bespoke MCP tool — a fail-fast single blocking
 * subscription over the live `nodes` stream.
 *
 * This is the floor that works on every MCP host: the model is *inside* a tool
 * call when the answer lands, so it needs no resource-notification support. It
 * blocks on the agent surface's `nodes` stream (the projected `{ run, pipeline,
 * sha7, seq, nodes[] }` frames) and returns the verdict the instant a node goes
 * red (fail-fast) or the whole run settles.
 *
 * It rides the bespoke-tool slot rather than an exposed procedure because it's
 * a *blocking read loop* with cancellation, fail-fast, and timeout policy —
 * call-shaped behaviour the live client doesn't expose as one verb. It reads
 * `client.surface.nodes.get({}, { signal })`, where `client` is the projected
 * agent client `@kolu/surface-mcp` hands the handler.
 */

import type { BespokeTool } from "@kolu/surface-mcp";
import { z } from "zod";
import { agentSummary } from "../cli/render";
import { formatRef } from "../common/runRecord";
import { SOCKET_PATH } from "../coordinator/socket";
import type { AgentNodes, AgentNodesReader } from "./agentSurface";

export const waitInput = z.object({
	timeout_ms: z.number().optional(),
	fail_fast: z.boolean().optional(),
	/** Refuse loudly unless the live run's commit matches this sha (a prefix
	 *  either way, so a 7- or 40-char sha both work) — the "wait for the run I
	 *  just dispatched, not a stale one" guard (juspay/odu#49 ask 3). */
	expected_sha: z
		.string()
		.describe(
			"Refuse loudly unless the live run's commit matches this. Prefix-matched " +
				"against the run's sha7 either way, so a full 40-char sha or the 7-char " +
				"sha7 from a prior verdict both work.",
		)
		.optional(),
});
export type WaitInput = z.infer<typeof waitInput>;

/** The loud refusal `wait_for_settle` raises instead of returning a semantically
 *  empty verdict: no run is live in this checkout, or the live run's commit
 *  doesn't match the caller's `expected_sha`. A typed error thrown from the
 *  handler — surface-mcp turns it into a failed `tools/call` carrying this
 *  message (the MCP analog of the CLI's stderr + non-zero exit), so the caller
 *  gets a loud error, never a `settled:false` nothing-verdict it can't tell
 *  apart from a real one (juspay/odu#49). */
export class NoLiveRunError extends Error {}

export interface SettleVerdict {
	/** Every node reached a terminal state within the timeout. */
	settled: boolean;
	/** Settled (or fail-fast tripped) with no red node. `false` while a red
	 *  node exists or on timeout. */
	passed: boolean;
	failed: string[];
	errored: string[];
	/** Returned early because a node went red (fail-fast), before the slow
	 *  lanes finished. */
	fail_fast_tripped: boolean;
	timed_out: boolean;
	/** The caller cancelled the wait (the MCP request was cancelled) before the
	 *  run settled or timed out. */
	cancelled: boolean;
	duration_ms: number;
	/** The run this verdict describes: `sha7` its 7-char commit, `seq` its
	 *  ordinal among runs of that commit (`<sha7>#<seq>`), so a caller can match
	 *  the verdict to the run it dispatched rather than a previously-settled one
	 *  (juspay/odu#49 ask 2). `seq` is null on the coordinator-close path when the
	 *  observed run never carried one. */
	sha7: string;
	seq: number | null;
}

export interface WaitOptions {
	client: AgentNodesReader;
	timeoutMs?: number;
	/** Return the instant a node goes red, rather than waiting for the whole
	 *  run to settle (default true — the "e2e failed, drill in now" loop). */
	failFast?: boolean;
	/** Refuse loudly unless the live run's `sha7` prefix-matches this (the tool's
	 *  `expected_sha`, juspay/odu#49 ask 3). Undefined skips the check. */
	expectedSha?: string;
	/** Caller cancellation (MCP request cancelled): aborts the read loop and
	 *  returns the cancelled verdict promptly. */
	signal?: AbortSignal;
	/** Injected clock for tests; defaults to `Date.now`. */
	now?: () => number;
}

/** The run-identity fields stamped into every verdict, from the frame it
 *  describes. No frame (a run that never appeared) reads the no-run value. */
function identityOf(snap: AgentNodes | undefined): Pick<SettleVerdict, "sha7" | "seq"> {
	return snap === undefined ? { sha7: "", seq: null } : { sha7: snap.sha7, seq: snap.seq };
}

/** Does the live run's `observed` sha7 satisfy the caller's `expected` sha? A
 *  prefix match either way, case-insensitive, so a 7-char sha7 and a full
 *  40-char sha both match. An empty side never matches (a no-sha frame must not
 *  silently satisfy any expectation). */
function shaMatches(observed: string, expected: string): boolean {
	if (observed === "" || expected === "") return false;
	const o = observed.toLowerCase();
	const e = expected.toLowerCase();
	return o.startsWith(e) || e.startsWith(o);
}

/** A fail-fast single blocking subscription over the live `nodes` stream:
 *  block and return the verdict the instant a node goes red (fail-fast) or the
 *  whole run settles. */
export async function waitForSettle(opts: WaitOptions): Promise<SettleVerdict> {
	const failFast = opts.failFast ?? true;
	const timeoutMs = opts.timeoutMs ?? 600_000;
	const now = opts.now ?? Date.now;
	const started = now();

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	// Caller cancellation (MCP request cancelled) aborts the same controller so
	// the read loop tears down promptly rather than held until settle/timeout.
	const onCallerAbort = (): void => controller.abort();
	if (opts.signal !== undefined) {
		if (opts.signal.aborted) controller.abort();
		else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
	}

	let last: AgentNodes | undefined;
	// The abort verdict (timeout vs caller-cancel), reused whether the read loop
	// throws on abort or ends cleanly — B's projected `nodes` stream (over A's
	// `nodes` cell) swallows the abort and ends the iterable rather than
	// rejecting, so both paths must classify an aborted controller as
	// timeout/cancel, not as a settled run.
	const abortedVerdict = (): SettleVerdict => {
		const cancelled = opts.signal?.aborted === true;
		const red =
			last !== undefined ? agentSummary(last) : { failed: [], errored: [] };
		return {
			settled: false,
			passed: false,
			failed: red.failed,
			errored: red.errored,
			fail_fast_tripped: false,
			timed_out: !cancelled,
			cancelled,
			duration_ms: now() - started,
			...identityOf(last),
		};
	};

	try {
		for await (const snap of await opts.client.surface.nodes.get(undefined, {
			signal: controller.signal,
		})) {
			last = snap;
			// The pre-run / no-run snapshot (`run: false`, empty rows) is not a
			// settled verdict — keep waiting for a real run's frames.
			if (!snap.run) continue;
			// A live run whose commit doesn't match what the caller dispatched is
			// refused LOUD, not silently waited on (juspay/odu#49 ask 3).
			if (
				opts.expectedSha !== undefined &&
				!shaMatches(snap.sha7, opts.expectedSha)
			) {
				throw new NoLiveRunError(
					`no live run matching ${opts.expectedSha} (this checkout is running ${formatRef(snap.sha7, snap.seq)})`,
				);
			}
			const { done, failed, errored } = agentSummary(snap);
			if (failFast && failed.length + errored.length > 0) {
				return {
					settled: done,
					passed: false,
					failed,
					errored,
					fail_fast_tripped: !done,
					timed_out: false,
					cancelled: false,
					duration_ms: now() - started,
					...identityOf(snap),
				};
			}
			if (done) {
				return {
					settled: true,
					passed: failed.length + errored.length === 0,
					failed,
					errored,
					fail_fast_tripped: false,
					timed_out: false,
					cancelled: false,
					duration_ms: now() - started,
					...identityOf(snap),
				};
			}
		}
		// Loop ended. If our controller is aborted, the stream ended *because* of
		// the timeout/cancel (the projected `nodes` stream swallows abort) — that's
		// an abort verdict, never a settled one.
		if (controller.signal.aborted) return abortedVerdict();
		// The stream ended with no settle and no abort. If we never observed a
		// LIVE run, there is none in this checkout — refuse LOUD, mirroring the
		// CLI (`odu status`), rather than an instant empty verdict a caller can't
		// tell apart from a real one (juspay/odu#49 ask 1).
		if (last === undefined || !last.run) {
			throw new NoLiveRunError(
				`no run in progress in this checkout (no live socket at ${SOCKET_PATH})`,
			);
		}
		// A live run WAS observed, but the coordinator then closed the socket
		// (crash, interrupt, or a close race) with nodes still pending/running.
		// `settled` is true only if the last snapshot was already terminal;
		// `passed` requires that — a green verdict must never come from a
		// half-observed run.
		const red = agentSummary(last);
		const settled = red.done;
		return {
			settled,
			passed: settled && red.failed.length + red.errored.length === 0,
			failed: red.failed,
			errored: red.errored,
			fail_fast_tripped: false,
			timed_out: false,
			cancelled: false,
			duration_ms: now() - started,
			...identityOf(last),
		};
	} catch (err) {
		// An abort that surfaces as a rejection (rather than a clean end) is the
		// same timeout/cancel verdict.
		if (controller.signal.aborted) return abortedVerdict();
		throw err;
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onCallerAbort);
	}
}

/** The `wait_for_settle` bespoke tool. Read-only (`mutates: false`): it observes the
 *  run, it doesn't change it. The explicit `mutates: false` opts into `readOnlyHint:
 *  true` under `@kolu/surface-mcp`'s conservative default (an unannotated tool is now
 *  treated as MUTATING so a host can't auto-run it unconfirmed). Typed as the loose
 *  `BespokeTool` (the package's `tools` slot is invariant in the input type); `input`
 *  validates, handler narrows. */
export const waitTool: BespokeTool = {
	description:
		"Block until the run settles, or — fail-fast (default) — the instant a " +
		"node goes red, so you can drill into a failure without waiting for the " +
		"slow lanes. Returns the verdict {settled, passed, failed[], errored[], " +
		"sha7, seq} — sha7#seq identifies WHICH run it describes. Fails LOUD (an " +
		"error, not an empty verdict) when no run is live in this checkout, or " +
		"when the live run's commit doesn't prefix-match `expected_sha`.",
	input: waitInput,
	mutates: false,
	handler: (args, client, signal) => {
		const a = args as WaitInput;
		return waitForSettle({
			client: client as AgentNodesReader,
			timeoutMs: a.timeout_ms,
			failFast: a.fail_fast,
			expectedSha: a.expected_sha,
			signal,
		});
	},
};
