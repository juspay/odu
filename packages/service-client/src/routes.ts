const RUN_PATH = "run/";

export function runHash(runId: string): string {
  return `#/${RUN_PATH}${runId}`;
}

/** The fragment for one attempt's LOG — the run page with that output open. */
export function logHash(logKey: string): string {
  return `#/${RUN_PATH}${logKey}`;
}

/** What a run address names. `log` is the log key, or `null` for the run page. */
export interface RunAddress {
  runId: string;
  log: string | null;
}

/** Read a fragment back, or `null` when it addresses no run. */
export function parseRunHash(hash: string): RunAddress | null {
  const path = hash.replace(/^#?\/?/, "");
  if (!path.startsWith(RUN_PATH)) return null;
  const token = path.slice(RUN_PATH.length);
  const parts = token.split("/");
  const runId = parts[0];
  if (runId === undefined || runId === "") return null;
  return { runId, log: parts.length === 3 ? token : null };
}
