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
  return `${span(now - at)} ago`;
}

/** How long until, as coarsely and on the same lines as {@link ago} — "in
 *  83d" — so a date a page says a thing leaves rounds the way the date it
 *  arrived does. Never negative: a moment already past reads "in 0s". */
export function ahead(at: number, now: number): string {
  return `in ${span(at - now)}`;
}

/** One stretch of time, in the largest unit that keeps it readable. */
function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
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

