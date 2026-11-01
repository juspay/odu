/**
 * THE ROW'S ONE ENVIRONMENT READ, kept in the ROW (the host only calls it).
 *
 * The row exists only when a token file is configured: a laptop daemon has no
 * Cloudflare account and no names, and a row that mounted without a token would
 * be a Tunnel panel showing a failure nobody asked for. A file that is SET but
 * unreadable is a refusal naming it, not a silent absence — the operator meant
 * to configure the row, and a tunnel that never appears is worse than a daemon
 * that says why at boot.
 */

import { readFileSync } from "node:fs";

/** The token's path; the module sets it from `services.odu.cloudflare.apiTokenFile`. */
const TOKEN_FILE = "ODU_CLOUDFLARE_API_TOKEN_FILE";
/** The API's base URL, for a stub (the browser suite) — unset in production. */
const API = "ODU_CLOUDFLARE_API";
/** Where a name is confirmed, for a deployment whose names are only reachable
 *  through a proxy — and for the browser suite's stub. Unset in production, so
 *  the row probes `https://<name>` itself. */
const PROBE_BASE = "ODU_CLOUDFLARE_PROBE_BASE";

export interface CloudflareConfig {
  readonly token: string;
  readonly apiBase: string | null;
  readonly probeBase: string | null;
}

export type CloudflareReading =
  | { readonly kind: "absent" }
  | { readonly kind: "config"; readonly config: CloudflareConfig }
  | { readonly kind: "refused"; readonly message: string };

const filled = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
};

export function readCloudflareConfig(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf-8"),
): CloudflareReading {
  const file = filled(env[TOKEN_FILE]);
  if (file === null) {
    // A base URL with no token is half a configuration.
    if (filled(env[API]) !== null) {
      return {
        kind: "refused",
        message:
          `${API} is set but ${TOKEN_FILE} is not — the cloudflare row needs ` +
          "the token it would call the API with",
      };
    }
    return { kind: "absent" };
  }
  let token: string;
  try {
    token = readFile(file).trim();
  } catch (err) {
    return {
      kind: "refused",
      message:
        `${TOKEN_FILE} names ${file}, which could not be read: ` +
        (err instanceof Error ? err.message : String(err)),
    };
  }
  if (token === "") {
    return {
      kind: "refused",
      message: `${TOKEN_FILE} names ${file}, which is empty — write a Cloudflare API token there`,
    };
  }
  return {
    kind: "config",
    config: { token, apiBase: filled(env[API]), probeBase: filled(env[PROBE_BASE]) },
  };
}
