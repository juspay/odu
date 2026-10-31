/**
 * HOW A NUMBER OF BYTES AND A MOMENT IN TIME ARE SAID, once, for every row.
 *
 * These two lived in three places — the runs' face, the cache's face and the
 * cache's argv face — and they had already drifted where a person could see it:
 * a bucket pushed to thirty hours ago read "30h ago" on one tab and "1d ago" on
 * the tab beside it, and a NAR over a mebibyte was sized in MiB by one face and
 * in GiB by the other. A board whose two halves round differently is a board
 * that makes a reader check which half they are on.
 *
 * They are here rather than in a face because they are not one row's idea of
 * anything: a run's age and a bucket's age are the same question, and every row
 * in the tree already depends on this package. It names no row, so the fence
 * stays green, and it is a leaf — pure functions, no state, no imports.
 */

/** How long ago, coarsely. Coarse on purpose: a board is scanned rather than
 *  read, and "3m ago" is what a scanner needs from a timestamp.
 *
 *  The hour/day line is 48, not 24: under a day a reader is comparing hour
 *  counts, and "1d ago" for something that ran this morning loses information
 *  nobody asked them to lose. */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Bytes as a person reads them — binary units, because a store is. */
export function bytes(count: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = count;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit] as string}`;
}

/** A refusal as the sentence a person reads. Every row's refusals are already
 *  written for a person; this only appends the recovery when the error carries
 *  one (`suggestion`, the runs' refusals' argv). One spelling, because three
 *  faces had three — and one of them dropped the recovery. */
export function refusalText(err: unknown): string {
  const value = err as { message?: unknown; suggestion?: unknown };
  const message = typeof value?.message === "string" ? value.message : String(err);
  const suggestion = Array.isArray(value?.suggestion)
    ? ` Try: ${(value.suggestion as unknown[]).map(String).join(" ")}`
    : "";
  return `${message}${suggestion}`;
}
