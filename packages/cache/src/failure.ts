/**
 * WHY SOMETHING FAILED — ALL OF IT, ON ONE LINE.
 *
 * A push that died on a production pod logged exactly this, and nothing else:
 *
 *     [odu] push failed: Unable to connect. Is the computer able to access the url?
 *
 * That sentence is Bun's `fetch` TypeError. It is not odu's, it names no
 * address, and on its own it cannot tell a DNS failure from a refused
 * connection from an expired certificate from a timeout — which is the entire
 * question a reader has. The facts that answer it were all present on the
 * error that was thrown: Node and Bun hang `code`, `errno`, `syscall`,
 * `hostname`, `address` and `port` off the error OBJECT, and nest the real
 * cause under `.cause`. Every one of them is lost the moment somebody keeps
 * `err.message` — which is what every catch on the push path used to do.
 *
 * So this walks the whole chain and prints everything on it. One line, because
 * a push's log is a line-oriented stream a run's node renders verbatim and a
 * multi-line error would be mistaken for several events; `←` between the
 * links, because the chain reads outwards-in — the sentence a caller saw
 * first, then the reason under it, then the syscall under that.
 *
 * `AggregateError.errors` are links too: that is how `fetch` reports a
 * happy-eyeballs dial where both the A and the AAAA address failed, and
 * keeping only one of them hides half the answer.
 *
 * Nothing here is summarised away and nothing is truncated. Whitespace is
 * collapsed, which is the only edit made at all, and it is made so that the
 * result is one line rather than to shorten anything.
 */

/**
 * THE FIELDS A CONNECTION FAILURE CARRIES. Not a general property dump: an
 * error's own enumerable keys include whatever a library decided to attach —
 * request objects, buffers, a whole response — and a log line is not the place
 * to discover them. These six are the ones the platform documents, and they
 * are between them enough to name the failure: `code` (`ENOTFOUND`,
 * `ECONNREFUSED`, `CERT_HAS_EXPIRED`, `UND_ERR_CONNECT_TIMEOUT`), the
 * `syscall` that produced it, and the address it was produced for.
 */
const DIAGNOSTIC_FIELDS = ["code", "errno", "syscall", "hostname", "address", "port"] as const;

/** One line, out of whatever the error put in. A `fetch` failure's message is
 *  a sentence, but a child's stderr spliced into an error is not. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** ONE LINK: its name, its own words, and every diagnostic fact it carries. */
function describeLink(value: unknown): string {
  if (typeof value !== "object" || value === null) return oneLine(String(value));
  const bag = value as Record<string, unknown>;
  const name = typeof bag.name === "string" && bag.name !== "" ? bag.name : "Error";
  const message = typeof bag.message === "string" ? oneLine(bag.message) : "";
  const facts: string[] = [];
  for (const field of DIAGNOSTIC_FIELDS) {
    const fact = bag[field];
    // An object here would render as `[object Object]`, which is noise rather
    // than a fact; everything the platform puts in these fields is a scalar.
    if (fact === undefined || fact === null || fact === "" || typeof fact === "object") continue;
    facts.push(`${field}=${oneLine(String(fact))}`);
  }
  const head = message === "" ? name : `${name}: ${message}`;
  return facts.length === 0 ? head : `${head} (${facts.join(", ")})`;
}

/** The chain, outermost first. The visit set is the CYCLE GUARD: `cause`
 *  chains are built by hand and nothing stops one from pointing back at an
 *  error already on it, which would otherwise be an infinite line. */
function linksOf(err: unknown): string[] {
  const seen = new Set<object>();
  const links: string[] = [];
  const pending: unknown[] = [err];
  while (pending.length > 0) {
    const link = pending.shift();
    if (typeof link !== "object" || link === null) {
      links.push(describeLink(link));
      continue;
    }
    if (seen.has(link)) continue;
    seen.add(link);
    links.push(describeLink(link));
    const bag = link as { cause?: unknown; errors?: unknown };
    if (bag.cause !== undefined && bag.cause !== null) pending.push(bag.cause);
    if (Array.isArray(bag.errors)) {
      for (const nested of bag.errors) {
        if (nested !== undefined && nested !== null) pending.push(nested);
      }
    }
  }
  return links;
}

/** An error, and everything under it. */
export function describeFailure(err: unknown): string {
  try {
    return linksOf(err).join(" ← ");
  } catch {
    // A getter on the chain threw — a proxy, or a lazily-built `cause`. The
    // description is a diagnostic, so it may never become the failure: a
    // caller already holds a worse one.
    return "an error that refused to describe itself";
  }
}
