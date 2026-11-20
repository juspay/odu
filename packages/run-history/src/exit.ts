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

const MAX_SIGNAL_NUMBER = 64;

/** The signal an exit status implies, or `null` when it implies none. */
export function signalFromExit(code: number | null): string | null {
  if (code === null) return null;
  const n = code - 128;
  if (n <= 0 || n > MAX_SIGNAL_NUMBER) return null;
  return NAMES[n] ?? `SIG${n}`;
}
