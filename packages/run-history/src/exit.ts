/**
 * What an exit status MEANS — one reading, in one place.
 *
 * A POSIX shell reports a child killed by signal *N* as exit status `128 + N`,
 * and odu runs every recipe through `bash -o pipefail -c`, so that is the only
 * signal information a node's outcome carries. Reading it is useful — "the
 * runner was OOM-killed" is a different afternoon from "the tests failed" —
 * and it is also a READING rather than a report: a program that exits 137 on
 * purpose is indistinguishable from one the kernel killed with SIGKILL.
 *
 * Its own module because it has two callers that must not disagree: the
 * coordinator STORES the reading on an attempt record, and the attention
 * reducer DERIVES it from the journal's exit code for runs whose sidecars are
 * gone. Two copies of the table would eventually answer differently about the
 * same number, and the field it fills is one a person acts on.
 */

/** Signal names for the numbers a shell actually surfaces. Beyond the common
 *  set the number is reported as `SIG<n>` rather than guessed at: signal
 *  numbering above the standard range is platform-specific, and a wrong name
 *  is worse than a number. */
const NAMES: Record<number, string> = {
  1: "SIGHUP",
  2: "SIGINT",
  3: "SIGQUIT",
  6: "SIGABRT",
  8: "SIGFPE",
  9: "SIGKILL",
  11: "SIGSEGV",
  13: "SIGPIPE",
  15: "SIGTERM",
};

/** The signal an exit status implies, or `null` when it implies none. */
export function signalFromExit(code: number | null): string | null {
  if (code === null) return null;
  const n = code - 128;
  // 64 is the ceiling of any real-time signal range odu will meet; above it
  // the number is an ordinary exit status that happens to be large.
  if (n <= 0 || n > 64) return null;
  return NAMES[n] ?? `SIG${n}`;
}
