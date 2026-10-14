/**
 * WHERE a run lives, in the web face's address — the fragment a caller links to.
 *
 * A run, and one attempt's output within it, are LINKABLE: a person pastes the
 * address into a message and whoever opens it is looking at the same failure
 * rather than at a board they then have to navigate. That makes the address part
 * of the contract rather than one page's private business — a link is minted by
 * whoever holds the run (an editor, a terminal, another app's panel) and opened
 * in the browser, and a second spelling of `#/run/` at each of those callers is
 * how one of them comes to mint an address the page does not answer.
 *
 * Two shapes, minted here and read here:
 *
 *   `#/run/<runId>`   — the run: its lanes, its verdict, what it still owes;
 *   `#/run/<logKey>`  — …with one attempt's output open. The key is `./logKey`'s
 *                       own token, verbatim, so the address in a URL bar and the
 *                       address an agent echoes into `log_read` are one string.
 *
 * The fragment deliberately carries no scheme and no host: the origin it hangs
 * off is whoever is serving the page — the daemon's own address for a browser on
 * its machine, or a forwarded door through another machine's browser. `./endpoint`
 * owns the origin half; a fragment that carried one would have to be rewritten by
 * every face that reached the same page another way.
 */

/** The path every run address starts with. One constant rather than three
 *  literals, because the mint and the read are the two halves of one spelling. */
const RUN_PATH = "run/";

/** The fragment for one RUN. */
export function runHash(runId: string): string {
  return `#/${RUN_PATH}${runId}`;
}

/**
 * The fragment for one attempt's LOG — the run page with that output open.
 *
 * Takes the KEY (`./logKey`'s token) rather than the three fields it carries:
 * the token is what every face already holds — `RunNode.logKey` on the wire, a
 * failure's own words — and a minter taking the fields would be a second place
 * the token gets assembled.
 */
export function logHash(logKey: string): string {
  return `#/${RUN_PATH}${logKey}`;
}

/** What a run address names. `log` is the log key, or `null` for the run page. */
export interface RunAddress {
  runId: string;
  log: string | null;
}

/**
 * Read a fragment back, or `null` when it addresses no run.
 *
 * `null` rather than a throw, for the reason `parseLogKey` gives: the input is a
 * string somebody typed or a page navigated to, and "that is not an address I
 * minted" is an answer the caller renders in its own words — in the web app, the
 * board, which is where a reader who mistyped one wants to be.
 *
 * A TOLERANT prefix and a STRICT body. The prefix takes the spellings a
 * `location.hash` and a link can produce (`#/run/x`, `/run/x`, `run/x`); the body
 * is strict about the one distinction the page draws: three segments IS a log key
 * — the same spelling `formatLogKey` mints — while two or four are the run page,
 * because that is what a truncated or hand-edited address degrades to and it
 * still names a run worth showing.
 */
export function parseRunHash(hash: string): RunAddress | null {
  const path = hash.replace(/^#?\/?/, "");
  if (!path.startsWith(RUN_PATH)) return null;
  const token = path.slice(RUN_PATH.length);
  const parts = token.split("/");
  const runId = parts[0];
  if (runId === undefined || runId === "") return null;
  return { runId, log: parts.length === 3 ? token : null };
}
