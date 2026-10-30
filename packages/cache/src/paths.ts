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
