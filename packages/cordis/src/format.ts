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

function span(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Bytes as a person reads them — binary units. */
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

