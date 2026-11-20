export const RUN_IDENTITY_VERSION = 1;

const RUN_ID_RE = /^[0-9a-z]{8,}-[0-9a-z]{4,}$/;

/**
 * Mint a globally unique run id: `<ms base36, 8 chars>-<random base36>`.
 */
export function mintRunId(
  now: number = Date.now(),
  random: () => number = Math.random,
): string {
  const ts = Math.floor(now).toString(36).padStart(9, "0");
  const tail = Math.floor(random() * 36 ** 8)
    .toString(36)
    .padStart(8, "0");
  return `${ts}-${tail}`;
}

/** Is this a well-formed run id — i.e. safe as a single path segment and
 *  matchable against the catalog? Rejects `.`/`..`, separators, and every
 *  spelling `mintRunId` cannot produce. */
export function isRunId(value: string): boolean {
  return RUN_ID_RE.test(value);
}

/** The instant a run id encodes, or `null` when it is not one this vocabulary
 *  minted. */
export function runIdStartedAt(runId: string): number | null {
  if (!isRunId(runId)) return null;
  const head = runId.split("-")[0];
  if (head === undefined) return null;
  const ms = Number.parseInt(head, 36);
  return Number.isSafeInteger(ms) ? ms : null;
}

const SAFE_KEY_CHAR = /^[A-Za-z0-9._-]$/;

function isSafeUnescaped(ch: string, atStart: boolean): boolean {
  if (!SAFE_KEY_CHAR.test(ch)) return false;
  return !(atStart && ch === ".");
}

function parseNonNegativeDigits(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * A node id as ONE path segment: every character outside the portable filename
 * set becomes `~<2 hex>`.
 */
export function encodeNodeKey(nodeId: string): string {
  let out = "";
  for (const ch of nodeId) {
    if (isSafeUnescaped(ch, out === "")) {
      out += ch;
      continue;
    }
    for (const byte of new TextEncoder().encode(ch)) {
      out += `~${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** The inverse of {@link encodeNodeKey}, or `null` for a string that this
 *  encoding could not have produced (a stray `~`, a bad hex pair, bytes that
 *  are not valid UTF-8). */
export function decodeNodeKey(key: string): string | null {
  if (key.startsWith(".")) return null;
  const bytes: number[] = [];
  for (let i = 0; i < key.length; ) {
    const ch = key[i];
    if (ch === undefined) return null;
    if (ch !== "~") {
      if (!SAFE_KEY_CHAR.test(ch)) return null;
      bytes.push(ch.charCodeAt(0));
      i += 1;
      continue;
    }
    const hex = key.slice(i + 1, i + 3);
    if (!/^[0-9A-F]{2}$/.test(hex)) return null;
    bytes.push(Number.parseInt(hex, 16));
    i += 3;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(bytes),
    );
  } catch {
    return null;
  }
}

/** An attempt ordinal is 1-based and dense per node: attempt 1 is the first
 *  time this run ran that node, and a rerun allocates the next. */
export function isAttemptOrdinal(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

/** The addressed identity of one piece of evidence: which run, which node,
 *  which attempt. */
export interface AttemptRef {
  runId: string;
  /** The fan-in node id (`<namepath>@<platform>`), DECODED — callers speak node
   *  ids and the store encodes at the path boundary. */
  node: string;
  attempt: number;
}

/** `<runId>/<node>#<attempt>` — the one display spelling for an attempt. */
export function formatAttemptRef(ref: AttemptRef): string {
  return `${ref.runId}/${ref.node}#${ref.attempt}`;
}

/**
 * A delivery cursor: how far through ONE run's journal a caller has been
 * served.
 */
export interface Cursor {
  runId: string;
  /** The last journal sequence delivered. `0` means "nothing yet", which is
   *  also what an absent cursor means — so a caller can start either way. */
  seq: number;
}

/** `<runId>@<seq>` — opaque to a caller, parseable here. */
export function formatCursor(cursor: Cursor): string {
  return `${cursor.runId}@${cursor.seq}`;
}

/** Parse a cursor token, or `null` when it is not one this vocabulary emitted. */
export function parseCursor(token: string): Cursor | null {
  const at = token.lastIndexOf("@");
  if (at <= 0) return null;
  const runId = token.slice(0, at);
  const tail = token.slice(at + 1);
  if (!isRunId(runId)) return null;
  const seq = parseNonNegativeDigits(tail);
  if (seq === null) return null;
  return { runId, seq };
}

/**
 * What a person may type after `--run`.
 */
export type RunSelector =
  | { kind: "latest" }
  | { kind: "id"; value: string }
  | { kind: "ref"; sha7: string; seq: number };

/** Parse a `--run` token. Never throws: an unparseable token is `null` and the
 *  caller refuses with the three forms named. */
export function parseRunSelector(token: string): RunSelector | null {
  const trimmed = token.trim();
  if (trimmed === "") return null;
  if (trimmed === "latest") return { kind: "latest" };
  const hash = trimmed.indexOf("#");
  if (hash > 0) {
    const sha7 = trimmed.slice(0, hash).toLowerCase();
    const seq = Number(trimmed.slice(hash + 1));
    if (!/^[0-9a-f]{4,40}$/.test(sha7)) return null;
    if (!Number.isSafeInteger(seq) || seq <= 0) return null;
    return { kind: "ref", sha7, seq };
  }
  if (!/^[0-9a-z-]{3,}$/.test(trimmed)) return null;
  return { kind: "id", value: trimmed };
}
