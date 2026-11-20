import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Result, Schema } from "effect";
import { type RunRecord, RunRecordSchema } from "./record";

const RUNS_SUBDIR = "runs";

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
 *  or 1 for the first run of this commit. */
export function allocateSeq(repoRoot: string, sha7: string): number {
  const seqs = existingSeqs(repoRoot, sha7);
  return seqs.length === 0 ? 1 : Math.max(...seqs) + 1;
}

/** Persist a run's record at `.ci/<sha7>/runs/<seq>.json`. Overwrites the same
 *  `(sha7, seq)` file. */
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
 * globally unique (juspay/odu#49).
 */
export function reserveNextSeq(repoRoot: string, sha7: string): number | null {
  try {
    mkdirSync(runsDir(repoRoot, sha7), { recursive: true });
  } catch {
    return null;
  }
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

/** Release a reservation for `seq` — but ONLY if it's still an unfinalized
 *  sentinel. Best-effort and idempotent (missing/finalized → no-op). */
export function releaseReservation(
  repoRoot: string,
  sha7: string,
  seq: number,
): void {
  const path = recordPath(repoRoot, sha7, seq);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return;
  }
  if (!isReservationSentinel(parsed)) return;
  try {
    rmSync(path, { force: true });
  } catch {
  }
}

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

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
  if (isReservationSentinel(parsed)) return null;
  const result = decodeRunRecord(parsed);
  return Result.isSuccess(result) ? result.success : null;
}

const decodeRunRecord = Schema.decodeUnknownResult(RunRecordSchema);

/** The finalized record for ONE run identity, or `null` when it is missing,
 *  still a reservation sentinel, or unparseable. */
export function readRunRecord(
  repoRoot: string,
  sha7: string,
  seq: number,
): RunRecord | null {
  return readRecord(recordPath(repoRoot, sha7, seq));
}

/** Every run record in this checkout's `.ci`, newest first (by `finishedAt`,
 *  then `seq` as a stable tiebreak). Unparseable files are skipped, not
 *  surfaced. */
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
