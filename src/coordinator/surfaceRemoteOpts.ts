/**
 * Shared plugs for `@kolu/surface-remote` call sites in the coordinator.
 *
 * surface-remote is policy-free: every dial must hand a COMPLETE `localEnv` for
 * a localhost spawn (unused on real ssh), and `makeSession` takes a structured
 * `Logger` rather than a bare line callback. One place so lane + lease can't
 * drift.
 */

import type { Logger } from "@kolu/log";

/** Clean HOME/PATH for a localhost odu-runner spawn — never ambient
 *  `process.env`. Mirrors drishti's inline composition (odu has no kolu-pty). */
export function localhostSpawnEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    (["HOME", "PATH"] as const)
      .map((k): [string, string | undefined] => [k, env[k]])
      .filter((e): e is [string, string] => e[1] !== undefined),
  );
}

/** Adapt a plain line sink into the structured {@link Logger} makeSession
 *  expects. Session emits `log[severity]({ line }, label)` — we surface the
 *  line (or the msg if the payload has none). */
export function lineLogger(onLine: (line: string) => void): Logger {
  const emit =
    (_severity: keyof Logger) =>
    (obj: Record<string, unknown>, msg: string): void => {
      const line = obj.line;
      onLine(typeof line === "string" && line.length > 0 ? line : msg);
    };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
  };
}
