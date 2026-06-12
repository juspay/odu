/**
 * `odu runs` — the run history. Unlike `status` / `logs` / `attach`, which
 * dial a live coordinator, this reads the durable ledger
 * (src/coordinator/ledger.ts) straight off disk, so it answers "what runs
 * happened here?" with *no* run in progress — the first odu command that
 * works against an idle checkout.
 *
 * `-o json` emits the raw records (the row source a service face consumes);
 * the default is a compact table, newest first.
 */

import { gitTopLevel } from "../common/git";
import { formatRunRef, type RunRecord } from "../common/runRecord";
import { readLedger } from "../coordinator/ledger";

/** A coarse "2h ago" / "3d ago" stamp — the ledger is browsed at human
 *  resolution, so seconds/minutes/hours/days is enough, and a future-dated
 *  clock skew degrades to "just now" rather than a negative age. */
export function formatAgo(deltaMs: number): string {
  const s = Math.floor(deltaMs / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Render the ledger as a fixed-column table, newest first. Pure over `now`
 *  (the caller passes `Date.now()`) so the relative ages are testable. The
 *  columns mirror the idle-attach sketch: ref · sha · outcome · lanes · age. */
export function renderRuns(records: readonly RunRecord[], now: number): string {
  if (records.length === 0) {
    return "no runs recorded in this checkout (.ci is empty)\n";
  }
  const rows = records.map((r) => {
    const sha = r.dirty ? `${r.sha7}+dirty` : r.sha7;
    const verdict =
      r.outcome === "passed"
        ? "✔ passed"
        : r.outcome === "failed"
          ? "✗ failed"
          : "✗ incomplete";
    return {
      ref: formatRunRef(r),
      sha,
      verdict,
      lanes: `${r.lanes.length} lane${r.lanes.length === 1 ? "" : "s"}`,
      age: formatAgo(Math.max(0, now - r.finishedAt)),
    };
  });
  const width = (pick: (row: (typeof rows)[number]) => string): number =>
    Math.max(...rows.map((row) => pick(row).length));
  const wRef = width((r) => r.ref);
  const wSha = width((r) => r.sha);
  const wVerdict = width((r) => r.verdict);
  const wLanes = width((r) => r.lanes);
  const lines = rows.map(
    (r) =>
      `${r.ref.padEnd(wRef)}  ${r.sha.padEnd(wSha)}  ${r.verdict.padEnd(
        wVerdict,
      )}  ${r.lanes.padEnd(wLanes)}  ${r.age}`,
  );
  return `${lines.join("\n")}\n`;
}

export async function runsCommand(json: boolean): Promise<number> {
  // The ledger is checkout-scoped; resolve the repo root the same way the MCP
  // durable-log fallback does (git top-level), falling back to cwd outside a
  // checkout so an explicit `.ci` there is still readable.
  const repoRoot = gitTopLevel() ?? process.cwd();
  const records = readLedger(repoRoot);
  process.stdout.write(
    json
      ? `${JSON.stringify(records, null, 2)}\n`
      : renderRuns(records, Date.now()),
  );
  return 0;
}
