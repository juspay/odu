/**
 * Shared plugs for `@kolu/surface-remote` call sites in the coordinator.
 *
 * surface-remote is policy-free: every dial must hand a COMPLETE `localEnv` for
 * a localhost spawn (unused on real ssh), and `makeSession` takes a structured
 * `Logger` rather than a bare line callback. One place so lane + lease can't
 * drift.
 */

import type { Logger } from "@kolu/log";

/** Non-secret runtime state a localhost runner needs from its host session.
 *
 * In particular, nix-quick-install-action configures macOS through the three
 * NIX_* variables below. Dropping NIX_SSL_CERT_FILE lets the already-realised
 * runner start, but makes recipe-level `nix develop` fail on its first fetch.
 */
const LOCALHOST_ENV_ALLOWLIST = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "NIX_PROFILES",
  "NIX_USER_PROFILE_DIR",
  "NIX_SSL_CERT_FILE",
] as const;

/** Clean environment for a localhost odu-runner spawn — never ambient
 *  `process.env`. */
export function localhostSpawnEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    LOCALHOST_ENV_ALLOWLIST
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
