export const CACHE_MOUNT = "/cache";

export const PARTS_HEADER = "x-odu-parts";
export const UPLOAD_SESSION_HEADER = "x-odu-upload";

export const RUN_HEADER = "x-odu-run";
export const COMMIT_HEADER = "x-odu-commit";

export interface Provenance {
  run: string | null;
  commit: string | null;
}

export function provenanceHeaders(stated: {
  run?: string;
  commit?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  const run = (stated.run ?? "").trim();
  if (run !== "") headers[RUN_HEADER] = run;
  const commit = (stated.commit ?? "").trim();
  if (commit !== "") headers[COMMIT_HEADER] = commit;
  return headers;
}

const MAX_PROVENANCE = 200;

function clipProvenance(value: string | undefined): string | null {
  const stated = (value ?? "").trim();
  return stated === "" ? null : stated.slice(0, MAX_PROVENANCE);
}

export function provenanceStated(headers: Record<string, string | undefined>): Provenance {
  return {
    run: clipProvenance(headers[RUN_HEADER]),
    commit: clipProvenance(headers[COMMIT_HEADER]),
  };
}

export const PUSH_API = "/_odu/v1";

export const NARINFO_SUFFIX = ".narinfo";

export type UploadMode = "direct" | "staged";

export type UploadPlan =
  | { mode: "staged" }
  | {
      mode: "direct";
      upload: string;
      partSize: number;
      part: string;
    };

export const ODU_ORIGIN_FIELD = "Odu-Origin";
export const ODU_BUCKET_FIELD = "Odu-Bucket";

/** Nix's base32, as a route fragment: a narinfo is named for its 32-character
 *  store-path hash. */
export const HASH_PATTERN = "[0-9abcdfghijklmnpqrsvwxyz]{32}";

export const CACHE_ROUTE_PATHS: ReadonlyArray<string> = [
  `${CACHE_MOUNT}/*`,
  `${PUSH_API}/*`,
  "/nix-cache-info",
  "/nar/*",
  `~^/${HASH_PATTERN}\\.narinfo$`,
];

export function bucketOf(path: string): string | null {
  for (const prefix of [`${CACHE_MOUNT}/`, `${PUSH_API}/buckets/`]) {
    if (!path.startsWith(prefix)) continue;
    const named = path.slice(prefix.length).split("/")[0] ?? "";
    return named === "" ? null : decodeURIComponent(named);
  }
  return null;
}
