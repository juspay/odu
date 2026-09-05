/**
 * How long a CI link may go quiet before odu gives up on it.
 *
 * ONE module because this is not a per-call-site tuning knob: it is a policy
 * with a partner on the other end of the wire, and the two must be read
 * together or the pair silently stops making sense.
 *
 * **The coupling.** `makeSession`'s liveness watchdog probes every
 * `intervalMs` and declares the link half-open if a probe has not answered
 * within `timeoutMs`; on the remote arm that verdict force-cycles the link,
 * which kills the runner attached to it (the runner is deliberately ephemeral
 * — it dies with the pipe, and that death is what frees the venue flock and
 * reaps the recipe process trees). So this policy is, in effect, "how long a
 * network blip may last before odu tears a builder's work down".
 *
 * The framework's defaults are 15s/10s — tuned for an interactive session
 * where a stale screen is the cost of waiting. A CI lane is the opposite
 * trade: its recipes have already spent minutes of a builder's time, and
 * throwing that away over a 20-second wifi stall is far worse than painting a
 * stale matrix for a minute. Hence a full minute between probes and two
 * minutes to answer one (`MAX_HEARTBEAT_TIMEOUT_MS` in `@kolu/surface/heartbeat`
 * is 2 min, and `MAX_HEARTBEAT_INTERVAL_MS` 5 min — this sits inside both).
 *
 * **The invariant.** {@link CI_LINK_WORST_CASE_SILENCE_MS} is the longest the
 * coordinator will sit on a silent link before calling it dead. The box-side
 * dead-man in `src/runner/leaseHold.ts` (`deadManMs`) must be at least that
 * long, or the builder hands the venue back during a blip the coordinator was
 * still prepared to ride out — and the run then loses a box it never stopped
 * wanting. The runner reads its own env on the box, so that side is a CODE
 * default rather than something the coordinator passes; `linkTolerance.test.ts`
 * pins the two against each other.
 *
 * TODO(kolu): `sshConnector` hardcodes `ServerAliveInterval=10` /
 * `ServerAliveCountMax=3` in `@kolu/surface-remote`'s `host.ts` — a 30-second
 * TCP-level patience that undercuts everything above, since ssh drops the
 * connection long before the surface watchdog has formed an opinion. A parallel
 * kolu PR makes that a per-dial `keepalive` option; once the npins kolu pin is
 * bumped, odu should pass `keepalive: { intervalS: 30, countMax: 10 }` to both
 * `sshConnector` calls (`lane.ts` and `lease.ts`) so the transport's patience
 * matches this module's. Do not consume the unmerged change.
 */

/** The liveness cadence odu gives every link that carries a CI lane or holds a
 *  venue lease. Passed as `makeSession`'s `liveness`. */
export const CI_LINK_LIVENESS = {
  intervalMs: 60_000,
  timeoutMs: 120_000,
} as const;

/** The longest a link may be silent before the coordinator treats it as dead:
 *  a probe fires at the end of one interval and is given the full timeout to
 *  answer. Every other silence budget in odu is compared against THIS number
 *  rather than against the two fields, so nobody has to re-derive the sum. */
export const CI_LINK_WORST_CASE_SILENCE_MS =
  CI_LINK_LIVENESS.intervalMs + CI_LINK_LIVENESS.timeoutMs;
