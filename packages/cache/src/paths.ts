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
 *  client: the join's part count, and (contract 2.4) the upload session whose
 *  parts are its own. */
export const PARTS_HEADER = "x-odu-parts";
export const UPLOAD_SESSION_HEADER = "x-odu-upload";

/** Where the push API lives — odu's own, beside the Nix protocol's mount. */
export const PUSH_API = "/_odu/v1";

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
