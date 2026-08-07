/**
 * Shared plugs for `@kolu/surface-remote` call sites in the coordinator.
 *
 * surface-remote is policy-free: every dial must hand a COMPLETE `localEnv` for
 * a localhost spawn (unused on real ssh), and `makeSession` takes a structured
 * `Logger` rather than a bare line callback. One place so lane + lease can't
 * drift.
 */

import type { Logger } from "@kolu/log";
import type { AgentClient, Session, SshProv } from "@kolu/surface-remote";
import { type LaneClient, laneClientOver } from "../common/surface";

/** Wait for the session to hold a client, then build odu's TYPED lane face over
 *  the same wire.
 *
 *  `sshConnector` hands back the structural `AgentClient` (= `SurfaceFace`):
 *  the dial is surface-generic, so per-member precision cannot live in the
 *  connector (kolu PLAN D2). It also hands back the link's own tag-keyed
 *  `dispatch` precisely so a consumer can build a second, precise face over it
 *  — which is what `laneClientOver` is. Re-deriving the face from odu's OWN
 *  surface value means the tags can only agree with what the runner serves;
 *  casting the connector's erased face would have been a second projection free
 *  to drift.
 *
 *  A missing dispatch is a framework bug, not a degraded mode, so it throws.
 *  Reading it right after `pin()` is honest here because odu's lanes and lease
 *  holds are ONE-SHOT: the first link death after attach is terminal, so there
 *  is no reconnect that could replace the dispatch under a cached face. */
export async function pinLaneFace(
  session: Session<AgentClient, SshProv>,
): Promise<LaneClient> {
  await session.pin();
  const dispatch = session.currentDispatch?.();
  if (dispatch === undefined) {
    throw new Error(
      "odu: the lane session produced no dispatch — surface-remote's ssh " +
        "connector always supplies one, so this is a framework bug, not a " +
        "reachable state",
    );
  }
  return laneClientOver(dispatch);
}

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
