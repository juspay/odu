/**
 * The resurrection BUDGET: how many times a run moves a platform's work to
 * another box before it calls the platform errored.
 *
 * A module rather than a constant inside `orchestrate` because the budget is
 * operator-facing — a flapping VPN wants more attempts, a CI runner that must
 * fail fast wants none — and because a rule an operator can change without a
 * release is worth being able to falsify directly (`laneResurrection.test.ts`),
 * the way `verdictGate.ts` and `shards.ts` are.
 *
 * The rest of the policy — which platforms qualify, and which work replays —
 * still lives in `run.ts`. Moving it here was measured and handed back: see
 * `.lens-debate/outcome.md`.
 */

/**
 * How many times a REMOTE primary lane may be rebuilt on a freshly claimed
 * venue after its link dies.
 *
 * Two by default, i.e. three lanes in total. A budget rather than an unbounded
 * retry because a lane that dies on attach every time is a broken host, not a
 * flaky network, and re-claiming forever would spend a CI run's whole wall
 * clock discovering that. Two is enough to recover from the failure this exists
 * for — a dropped link, and then the unlucky second one — while a genuinely
 * sick box reaches a red verdict in minutes.
 *
 * `ODU_MAX_LANE_RESURRECTIONS` moves it without a release, the way
 * `ODU_LINGER_IDLE_MS` and `ODU_LEASE_MAX_HOLD_MS` move their budgets. **`0`
 * disables resurrection entirely** — a lane death terminalizes its platform on
 * the spot, exactly as it did before this feature existed — which makes it the
 * field escape hatch as well as a tuning knob, so it is a reachable value and
 * not merely a small one. A value that is not a whole number of attempts is
 * refused rather than acted on: silently rounding an operator's `1.5` would be
 * a budget nobody asked for.
 */
export function maxLaneResurrections(env = process.env): number {
  const raw = env.ODU_MAX_LANE_RESURRECTIONS;
  if (raw === undefined || raw === "") return 2;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 2;
}
