/**
 * The run ledger — the on-disk home of the durable run records
 * (src/common/runRecord.ts), and the append-only history every face reads
 * when no coordinator socket is live.
 *
 * Layout sits beside the per-SHA logs the coordinator already writes:
 *
 *   .ci/<sha7>/<platform>/<node>.log   ← logs (unchanged)
 *   .ci/<sha7>/runs/<seq>.json         ← one record per run of that commit
 *
 * Keeping records under `.ci/<sha7>/` groups a commit's runs with their logs,
 * and makes `seq` allocation a local directory scan. The ledger is the union
 * across every commit dir: `readLedger` walks each `.ci/<sha7>/runs/` and reads
 * its `<seq>.json` files. It is deliberately forgiving — a record it can't
 * parse (a future format, a partial write) is skipped, never thrown, so one
 * bad file never blinds `odu runs` to the rest of the history.
 *
 * `.ci` is checkout-scoped, like `.ci/odu.sock` — one run per checkout, so
 * `seq` allocation never races (the socket lock already serializes runs here).
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type RunRecord, RunRecordSchema } from "../common/runRecord";

const RUNS_SUBDIR = "runs";

/** The marker key a reservation sentinel carries (`reserveNextSeq`). `readRecord`
 *  skips a file with it set EXPLICITLY, so keeping a reserved (not-yet-finalized)
 *  run out of `odu runs` is a named contract between the writer and the reader —
 *  not a side effect of the sentinel happening to fail `RunRecordSchema` (which a
 *  stricter future reader might stop silently skipping). */
const RESERVED_MARKER = "reserved";

function isReservationSentinel(parsed: unknown): boolean {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    (parsed as Record<string, unknown>)[RESERVED_MARKER] === true
  );
}

function runsDir(repoRoot: string, sha7: string): string {
  return join(repoRoot, ".ci", sha7, RUNS_SUBDIR);
}

/** Where a single run's record file lives. */
export function recordPath(
  repoRoot: string,
  sha7: string,
  seq: number,
): string {
  return join(runsDir(repoRoot, sha7), `${seq}.json`);
}

/** Read the `<seq>.json` stems already present for a commit. Returns the
 *  numeric seqs (unsorted); a missing/unreadable runs dir is an empty list. */
function existingSeqs(repoRoot: string, sha7: string): number[] {
  let entries: string[];
  try {
    entries = readdirSync(runsDir(repoRoot, sha7));
  } catch {
    return [];
  }
  const seqs: number[] = [];
  for (const entry of entries) {
    const match = /^(\d+)\.json$/.exec(entry);
    if (match === null) continue;
    const seq = Number(match[1]);
    if (Number.isInteger(seq) && seq > 0) seqs.push(seq);
  }
  return seqs;
}

/** The next `seq` for a commit: one past the highest record already on disk,
 *  or 1 for the first run of this commit. Safe without locking because a
 *  checkout serves one run at a time (the `.ci/odu.sock` lock). */
export function allocateSeq(repoRoot: string, sha7: string): number {
  const seqs = existingSeqs(repoRoot, sha7);
  return seqs.length === 0 ? 1 : Math.max(...seqs) + 1;
}

/** Persist a run's record at `.ci/<sha7>/runs/<seq>.json`. Overwrites the same
 *  `(sha7, seq)` file — so a lingering run that re-finalizes on each drain
 *  refreshes its own record in place rather than accreting duplicates. `sha7`
 *  is the directory key supplied by the coordinator (the record holds only the
 *  full `sha`); the layout stays `.ci/<sha7>/`. */
export function writeRunRecord(
  repoRoot: string,
  sha7: string,
  record: RunRecord,
): void {
  const path = recordPath(repoRoot, sha7, record.seq);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Atomically select AND reserve the next seq for a commit, returning the
 * reserved seq — or `null` if it couldn't be claimed (a write failure).
 *
 * Combining selection and reservation is what makes a published `<sha7>#<seq>`
 * globally unique (juspay/odu#49). `allocateSeq` alone is a read (a directory
 * scan): two same-checkout starters can both pick the same number before either
 * writes, and the fail-fast socket lock (serveSocket) is acquired *later*, so it
 * doesn't serialize the pick. Here each candidate is claimed with an EXCLUSIVE
 * create (`flag: "wx"` → `O_CREAT|O_EXCL`): if the file already exists (a
 * finalized record OR another run's reservation) the create fails `EEXIST` and
 * we advance to the next candidate. So no two runs can hold the same slot, and
 * the exclusive create never truncates an existing record.
 *
 * The reservation is a sentinel that `readLedger` skips (by its `reserved`
 * marker) — so a live/reserved run never appears in `odu runs` as finished
 * history; the first `writeRunRecord` overwrites the sentinel with the real
 * record. Best-effort by design: a genuine write failure returns `null`
 * rather than throwing, so the caller proceeds WITHOUT a seq (publishing no
 * identity claim) rather than gating the run — the repo's "run history is a
 * convenience, never a gate" rule.
 */
export function reserveNextSeq(repoRoot: string, sha7: string): number | null {
  try {
    mkdirSync(runsDir(repoRoot, sha7), { recursive: true });
  } catch {
    return null;
  }
  // Start from the scan's best guess, then let the exclusive create arbitrate
  // races by advancing on EEXIST. Bounded so a pathological directory can't spin
  // forever.
  let candidate = allocateSeq(repoRoot, sha7);
  for (let attempt = 0; attempt < 1024; attempt += 1, candidate += 1) {
    try {
      writeFileSync(
        recordPath(repoRoot, sha7, candidate),
        `${JSON.stringify({ [RESERVED_MARKER]: true, seq: candidate }, null, 2)}\n`,
        { flag: "wx" },
      );
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      return null;
    }
  }
  return null;
}

/** Child directory names under `dir`, or `[]` if it doesn't exist. */
function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** One record file, or `null` if it's missing or doesn't parse as a record of
 *  a version this reader understands (a future format / a torn write). */
function readRecord(path: string): RunRecord | null {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // A reservation sentinel is not a finished run — skip it by its marker, so a
  // reserved-but-unfinalized run stays out of `odu runs` explicitly (see
  // RESERVED_MARKER), independent of whether it would also fail the schema.
  if (isReservationSentinel(parsed)) return null;
  const result = RunRecordSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** Every run record in this checkout's `.ci`, newest first (by `finishedAt`,
 *  then `seq` as a stable tiebreak). The history `odu runs` prints and a
 *  service face reads; unparseable files are skipped, not surfaced. */
export function readLedger(repoRoot: string): RunRecord[] {
  const ciDir = join(repoRoot, ".ci");
  const records: RunRecord[] = [];
  for (const sha7 of childDirs(ciDir)) {
    const dir = join(ciDir, sha7, RUNS_SUBDIR);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const record = readRecord(join(dir, entry));
      if (record !== null) records.push(record);
    }
  }
  records.sort((a, b) =>
    b.finishedAt !== a.finishedAt
      ? b.finishedAt - a.finishedAt
      : b.seq - a.seq,
  );
  return records;
}
