/**
 * `odu runs` — THIS CHECKOUT's run history. Unlike `status` / `logs` /
 * `attach`, which dial a live coordinator, this reads the durable ledger
 * (packages/run-history/src/legacy/ledger.ts) straight off disk, so it answers
 * "what runs happened here?" with *no* run in progress — the first odu command
 * that worked against an idle checkout.
 *
 * `-o json` emits the raw records (the row source a service face consumes);
 * the default is a compact table, newest first.
 *
 * THE SPLIT WITH `odu history list`, because there are now two histories and a
 * reader should know which one it is looking at. This one is CHECKOUT-scoped
 * and answers in `<sha7>#<seq>` — the ordinal a commit status links to, and the
 * shape every existing consumer of `-o json` already parses. `odu history list`
 * is the PER-USER catalog: it is addressed by run id, it survives the checkout
 * being deleted, it holds per-attempt evidence, and it is what PR 2's service
 * discovers runs from. The coordinator writes both on every run, so a run
 * started here appears in both; what only the catalog has is a run whose
 * checkout is gone, one imported from an old `.ci`, or one started somewhere
 * else. Neither is a projection of the other, and this file deliberately does
 * not merge them — a joined table would have to invent a shared identity for
 * records that genuinely have two.
 */

import { deadRun, describeDeadRun } from "@odu/run-client/deadRun";
import { gitTopLevel, shortSha } from "../common/git";
import { formatRunRef, type RunRecord } from "@odu/run-history/legacy/record";
import { readLedger } from "@odu/run-history/legacy/ledger";
import { unpostedNote } from "../coordinator/statuses";

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
    const sha7 = shortSha(r.sha);
    const sha = r.dirty ? `${sha7}+dirty` : sha7;
    const base =
      r.outcome === "passed"
        ? "✔ passed"
        : r.outcome === "failed"
          ? "✗ failed"
          : "✗ incomplete";
    const debt = unpostedNote(r.unposted?.length ?? 0);
    // unpostedNote prefixes with ", " for the run-summary join; strip for table.
    const verdict = debt !== "" ? `${base}${debt}` : base;
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
  // A run killed with its host never finalized a record: the ledger alone
  // would swear it never ran — the same lie `renderRuns`'s empty answer
  // ("(.ci is empty)") would tell straight over the residue. Name the death
  // on stderr (the table goes above stdout; the JSON stream stays raw
  // records for the service face that consumes it) — the MCP `runs` tool
  // answers the same sentence from the same detector.
  const dead = await deadRun(repoRoot);
  if (dead !== null) {
    (json ? process.stderr : process.stdout).write(
      `${describeDeadRun(dead)}\n`,
    );
  }
  process.stdout.write(
    json
      ? `${JSON.stringify(records, null, 2)}\n`
      : dead !== null && records.length === 0
        ? "no runs recorded in this checkout\n"
        : renderRuns(records, Date.now()),
  );
  // An empty checkout ledger is not the same as no history: the per-user
  // catalog may hold runs from a checkout that has since been deleted, or an
  // import of an older `.ci`. Say where else to look — on stderr, and only
  // when there is nothing to show, so no existing consumer of this command's
  // stdout sees a byte it did not before.
  if (!json && records.length === 0) {
    process.stderr.write(
      "odu: the per-user catalog may still have runs — try `odu history list --all`\n",
    );
  }
  return 0;
}
