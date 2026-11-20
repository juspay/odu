import { isHolderLive, type ProcessIdentity } from "@kolu/surface-daemon";
import { processIdentityFromEnv } from "osfacts-client";

export type { ProcessIdentity };

const OSFACTS_BIN_ENV = "ODU_OSFACTS_BIN";

export function selfProcessIdentity(): ProcessIdentity {
  const identity = processIdentityFromEnv(OSFACTS_BIN_ENV, process.pid);
  if (identity === undefined) {
    throw new Error(
      `odu: osfacts reports this process (pid ${process.pid}) as gone — ` +
        "refusing to claim the web service's gate on a reading that cannot " +
        "be true",
    );
  }
  return identity;
}

export function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  if (!isHolderLive(pid)) return undefined;
  try {
    return processIdentityFromEnv(OSFACTS_BIN_ENV, pid);
  } catch (err) {
    throw new Error(
      `odu: pid ${pid} is alive but its start time could not be read ` +
        `(${(err as Error).message}) — refusing to treat its gate as free`,
    );
  }
}
