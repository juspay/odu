/**
 * WHERE THE CACHE'S PROTOCOL IS MOUNTED — one literal, in one place.
 *
 * The bucket is NOT the origin's first path segment, and that is a correction
 * rather than a preference: `<origin>/<bucket>/…` puts the protocol in a shape
 * that collides with the board the same origin serves. The shell answers
 * `/assets/<hashed bundle>`, the cache's `/:bucket/:name` route outranks the
 * shell's `/*` catch-all, and `/assets` is a perfectly legal bucket name — so
 * every browser got an empty 404 for its own JavaScript and the page rendered
 * blank. A router cannot ask "is this bucket-shaped"; it can rank a literal
 * above a parameter, so the protocol gets a literal of its own.
 *
 * `cache` is a reserved word of the product, not of the router: it says what
 * the path is, it can never be shadowed by a bucket (a bucket named `cache`
 * lives under it), and the substituter URL a client is told —
 * `<origin>/cache/<bucket>` — reads as what it is. The admin API next door has
 * the same shape (`/_odu/v1/buckets/…`), and both are spelled once.
 *
 * Lives in its own module because the SERVER (`./routes`) and the CLIENT
 * (`./push`) both need it, and the client must not import the router.
 */
export const CACHE_MOUNT = "/cache";

/** A chunked upload's two headers, spelled once for the server and the
 *  client: the join's part count, and (since the cache row's 2.4) the upload session whose
 *  parts are its own. */
export const PARTS_HEADER = "x-odu-parts";
export const UPLOAD_SESSION_HEADER = "x-odu-upload";

/**
 * WHAT BUILT A PATH, carried beside the narinfo rather than inside it.
 *
 * A narinfo's BODY is a format Nix itself parses, and a cache that grew odu
 * fields in it would be handing every `nix copy` reader lines it has to
 * ignore — and would have to keep ignoring them forever. The provenance is
 * odu's own fact about the push, so it rides as request headers on the one
 * request that writes the row, and a server that does not know them records
 * a path with no provenance rather than refusing the push.
 *
 * Both are OPAQUE to the cache: it never learns what a run is, only that a
 * row can name one. Spelled here beside the mount so the SERVER (`./routes`)
 * and the CLIENT (`./push`) read the same two words — and, below, so they
 * obey the same RULE about them: one writer of the headers, one reader, and
 * the bound that protects the row in the reader.
 */
export const RUN_HEADER = "x-odu-run";
export const COMMIT_HEADER = "x-odu-commit";

/** The pair as a row holds it: `null` for a fact nobody stated, which is the
 *  ordinary value and not a gap — a developer pushing from a laptop states
 *  neither, and the GitHub action states only the commit. */
export interface Provenance {
  run: string | null;
  commit: string | null;
}

/**
 * THE HEADERS A PUSH SENDS — a key per fact STATED, and no key at all for
 * one that was not.
 *
 * AN EMPTY STRING IS NOTHING SAID, which is the whole distinction: a workflow
 * expanding `${{ github.sha }}` on a dispatch that has none hands the pusher
 * `""`, and a row claiming it was built from `""` is worse than a row
 * claiming nothing. Callers pass what they have, empty or not, and never
 * guard — which is why neither the CLI nor the Action repeats this test.
 */
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

/** A commit sha is 40 characters, a run id a handful more; 200 is room for
 *  every spelling either will ever take and still a bound. */
const MAX_PROVENANCE = 200;

/**
 * AND THE READING OF THEM, where the bound lives — on the ROW's side, not the
 * router's: whatever reads these headers is about to write `object.run` and
 * `object.commit_sha`.
 *
 * TRIMMED AND TRUNCATED, NOT REFUSED. These headers are attacker-controlled
 * on a public bucket — anyone who may write to it may send a megabyte of
 * them — and the row must not grow a column of whatever arrives. Truncating
 * rather than refusing is deliberate: the provenance is a LABEL, and a push
 * whose bytes are good is not worth rejecting over a decoration that is too
 * long. What lands is visibly clipped, which is the honest reading of an
 * over-long claim; nothing downstream parses it.
 *
 * An absent or empty header is `null` — nothing said, which the row reads as
 * "leave what is there".
 */
export function provenanceStated(
  headers: Record<string, string | undefined>,
): Provenance {
  const stated = (header: string): string | null => {
    const value = (headers[header] ?? "").trim();
    return value === "" ? null : value.slice(0, MAX_PROVENANCE);
  };
  return { run: stated(RUN_HEADER), commit: stated(COMMIT_HEADER) };
}

/** Where the push API lives — odu's own, beside the Nix protocol's mount. */
export const PUSH_API = "/_odu/v1";

/** What a narinfo request's path ends in — the Nix protocol's own spelling,
 *  beside the mount for the same reason: the router matches on it and the
 *  meter reads it off a refused request's path. */
export const NARINFO_SUFFIX = ".narinfo";

/**
 * WHERE A NAR'S BYTES GO (PLAN 2.9) — the shape of the one question a push
 * asks before it sends any, and of the answer.
 *
 * Here, beside the mount, for the reason the mount is here: the SERVER
 * answers it (`./staging`) and the CLIENT reads it (`./push`), and the client
 * must import no router, no store and no database. One declaration, so the
 * two halves of the negotiation cannot drift.
 */
export type UploadMode = "direct" | "staged";

export type UploadPlan =
  | { mode: "staged" }
  | {
      mode: "direct";
      /** This upload's handle — the `:upload` of its part and completion
       *  paths. Odu's own, not the store's. */
      upload: string;
      /** What every part but the last must be. The client slices to it, so
       *  the store is never handed a part it would refuse for being short. */
      partSize: number;
      /**
       * WHERE PART 0 GOES. Every byte of a direct upload is a PART — there is
       * no plain PUT, because a plain PUT leaves the key writable for as long
       * as its URL lives and odu has to PROVE that key afterwards. Part URLs
       * stop writing when the upload is completed.
       *
       * The first one rides on the plan so the common case — a NAR that fits
       * in one part — costs the same three requests a single PUT would have:
       * begin, the part, the completion. The rest are asked for one at a time.
       */
      part: string;
    };

/**
 * THE TWO LINES A CACHE SAYS ABOUT ITSELF in `nix-cache-info` — where its
 * push API is, and which bucket the reader is looking at.
 *
 * Spelled here for the same reason the mount is: the SERVER writes them
 * (`./staging`'s `nixCacheInfo`, the routes, the object in the store) and the
 * CLIENT reads them (`./push`'s `describeCache`, behind `odu cache push
 * --cache`), and the client must import no router and no store. Nix ignores
 * keys it does not know, so these cost a reader nothing.
 */
export const ODU_ORIGIN_FIELD = "Odu-Origin";
export const ODU_BUCKET_FIELD = "Odu-Bucket";

/** Nix's base32, as a route fragment: a narinfo is named for its 32-character
 *  store-path hash, and a DOMAIN's root route has no bucket segment to make the
 *  route unambiguous. */
export const HASH_PATTERN = "[0-9abcdfghijklmnpqrsvwxyz]{32}";

/**
 * THE PATHS THE CACHE ROW CLAIMS, beside the routes it registers.
 *
 * A bucket DOMAIN forwards every path of its hostname to the daemon, and the
 * host's gate uses this list (through `BucketDomains.paths`) to keep the board,
 * `/mcp`, `/auth` and the websocket off that name. The claim is also what the
 * door gate composes for `/cache/*` and `/_odu/v1/*`.
 */
export const CACHE_ROUTE_PATHS: ReadonlyArray<string> = [
  `${CACHE_MOUNT}/*`,
  `${PUSH_API}/*`,
  "/nix-cache-info",
  "/nar/*",
  `~^/${HASH_PATTERN}\\.narinfo$`,
];

/**
 * THE BUCKET A PATH NAMES, in either spelling, or `null` when it names none.
 *
 * The cache's own grammar, published as part of the `BucketDomains` fact: a
 * bucket's DOMAIN forwards every path to the daemon, and the host's gate asks
 * this question rather than spelling `/cache/<name>` a second time. A change
 * to the mount or the push API's path is then one edit, not two that can drift.
 */
export function bucketOf(path: string): string | null {
  for (const prefix of [`${CACHE_MOUNT}/`, `${PUSH_API}/buckets/`]) {
    if (!path.startsWith(prefix)) continue;
    const named = path.slice(prefix.length).split("/")[0] ?? "";
    return named === "" ? null : decodeURIComponent(named);
  }
  return null;
}
