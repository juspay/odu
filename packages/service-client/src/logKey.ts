/**
 * The LOG KEY — one token that addresses one attempt's output, host-globally.
 *
 * A node's log lives at the intersection of three facts: which run, which node,
 * which attempt. Every face has to be able to hand that address to a caller and
 * take it back verbatim: an attention failure names the log it came from, an
 * agent echoes that name into `log_read`, a browser makes it the key of a
 * collection item, and an MCP host makes it a URI segment. Three fields would
 * be three chances for one of those hops to reassemble it differently — and the
 * MCP hop in particular has nowhere to put three fields, because a resource is
 * addressed by a URI and a URI segment is one string.
 *
 * So the three facts travel as ONE token, minted here and parsed here.
 *
 * The node id is percent-ish encoded by the catalog's own `encodeNodeKey`
 * rather than by a second rule invented here: a node id is `<namepath>@<platform>`
 * and namepaths carry `::`, which is exactly the sort of thing a hand-rolled
 * split would get wrong once and then get wrong the same way in both
 * directions. Reusing the catalog's spelling also means the key a face shows
 * and the directory the evidence sits in are the same string, so an operator
 * looking for a log by hand finds it.
 */

import { decodeNodeKey, encodeNodeKey, isAttemptOrdinal } from "@odu/run-history/ids";

/** The three facts a log key carries. */
export interface LogKey {
  runId: string;
  /** `<namepath>@<platform>`, decoded. */
  node: string;
  /** 1-based attempt ordinal. */
  attempt: number;
}

/** The separator. `/` because the encoded node key cannot contain one (that is
 *  what `encodeNodeKey` guarantees — the encoding exists so the key is a legal
 *  single path segment) and because it reads as an address in every face that
 *  shows it. */
const SEP = "/";

/** Mint the token. */
export function formatLogKey(key: LogKey): string {
  return [key.runId, encodeNodeKey(key.node), String(key.attempt)].join(SEP);
}

/**
 * Read the token back, or `null`.
 *
 * `null` rather than a throw, and rather than a partial parse: every caller of
 * this is holding a string somebody else typed — an agent's echo, a URI
 * segment, an argv token — and the only useful answer for a malformed one is
 * "that is not a key I issued", which the face then reports in its own words.
 * A parse that guessed at a missing attempt would address a different attempt's
 * evidence and say nothing about having done so.
 */
export function parseLogKey(token: string): LogKey | null {
  const parts = token.split(SEP);
  if (parts.length !== 3) return null;
  const [runId, encodedNode, rawAttempt] = parts;
  if (runId === undefined || runId === "") return null;
  if (encodedNode === undefined || encodedNode === "") return null;
  if (rawAttempt === undefined || !/^[0-9]+$/.test(rawAttempt)) return null;
  const attempt = Number(rawAttempt);
  if (!isAttemptOrdinal(attempt)) return null;
  const node = decodeNodeKey(encodedNode);
  if (node === null) return null;
  return { runId, node, attempt };
}
