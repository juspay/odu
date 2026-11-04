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

/** Where the push API lives — odu's own, beside the Nix protocol's mount. */
export const PUSH_API = "/_odu/v1";

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
      /** A single-object PUT, for a NAR that fits in one part. */
      put: string;
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
