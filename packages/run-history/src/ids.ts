/**
 * The identities a durable run is addressed by — run, node key, attempt, and
 * the delivery cursor a caller advances through.
 *
 * Every one of them is a STRING that ends up in two places at once: a path
 * segment on disk and a token a person types on a command line. So the
 * spellings live together here rather than beside whichever writer first
 * needed one, and each has an explicit inverse the store can rely on. A node
 * id is `<namepath>@<platform>` (`@odu/run-client/nodeId` owns that format),
 * which is a fine map key and a poor directory name — `::` and `@` are legal
 * on POSIX and hostile on Windows, and a crafted namepath is a path traversal
 * — so the catalog stores the ENCODED key and decodes on the way out.
 *
 * Pure: no filesystem, no clock beyond the one `mintRunId` is handed. The
 * layout that consumes these lives in `./paths`.
 */

/** The current identity vocabulary. Bumped when a spelling below changes
 *  shape, so a reader that finds a record it cannot address says so rather
 *  than guessing. Travels on the manifest (see `./schema`). */
export const RUN_IDENTITY_VERSION = 1;

// ── run id ──────────────────────────────────────────────────────────────────

/** Characters a run id may contain: base36 plus the one separator. Anything
 *  else is a caller's typo or an attempt to reach out of the catalog dir, and
 *  both are refused by the same test. */
const RUN_ID_RE = /^[0-9a-z]{8,}-[0-9a-z]{4,}$/;

/**
 * Mint a globally unique run id: `<ms base36, 8 chars>-<random base36>`.
 *
 * TIME LEADS, and that is the only interesting decision here. The catalog is a
 * directory, discovery is a `readdir`, and "newest first" is the order every
 * face wants — so an id that sorts lexicographically by start instant makes
 * the common listing a sort of strings rather than a stat of every manifest.
 *
 * The WIDTH is what makes that sort correct, and it is load-bearing rather
 * than cosmetic: the moment the millisecond count needs one more base36 digit,
 * every new id grows a character and sorts BEFORE every old one, silently
 * inverting the listing. Nine digits reach `36**9` ms — the year 5188 — so the
 * horizon is not a date anyone will meet. (Eight would have been the year
 * 2059, which very much is.)
 *
 * The random tail is what makes it UNIQUE rather than merely ordered: two
 * coordinators can start in the same millisecond on the same machine (a
 * fan-out of `odu run` from a script does exactly this), and the catalog has
 * no lock to serialize them. Uniqueness is not left to the clock.
 *
 * The commit is deliberately NOT in the id. A run id addresses a run for the
 * rest of its life, including after the commit it ran is gone; `<sha7>#<seq>`
 * remains the display ref (`@odu/run-client`'s `formatRef`), and the manifest
 * carries both so either can find the other.
 */
export function mintRunId(
  now: number = Date.now(),
  random: () => number = Math.random,
): string {
  const ts = Math.floor(now).toString(36).padStart(9, "0");
  // 8 base36 digits ≈ 41 bits — enough that a same-millisecond collision is
  // not a thing anyone will meet, and short enough to type.
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
 *  minted. Used for retention (an expiry that needs no manifest read) and for
 *  the newest-first listing's tiebreak. */
export function runIdStartedAt(runId: string): number | null {
  if (!isRunId(runId)) return null;
  const head = runId.split("-")[0];
  if (head === undefined) return null;
  const ms = Number.parseInt(head, 36);
  return Number.isSafeInteger(ms) ? ms : null;
}

// ── node keys ───────────────────────────────────────────────────────────────

/** The characters that survive encoding unescaped — the portable filename set,
 *  minus `~` which is the escape marker. */
const SAFE_KEY_CHAR = /^[A-Za-z0-9._-]$/;

/**
 * A node id as ONE path segment: every character outside the portable filename
 * set becomes `~<2 hex>`.
 *
 * Reversible by construction (`decodeNodeKey`), which is what lets the store
 * list a run's attempts without a sidecar index mapping directories back to
 * node ids. It is also the traversal guard: `.` and `/` and `..` cannot
 * survive — `/` is not in the safe set, so `../../etc` encodes to
 * `..~2F..~2Fetc`, a single harmless segment. A caller therefore never has to
 * remember to validate a node id before joining it onto a path, because the
 * encoded form has no way to mean anything but a name.
 *
 * `~` itself is escaped (`~7E`) so the encoding is injective: without that,
 * `a~2F` and `a/` would share a spelling and the inverse would be a guess.
 */
export function encodeNodeKey(nodeId: string): string {
  let out = "";
  for (const ch of nodeId) {
    // A LEADING dot is escaped even though `.` is otherwise safe, and that one
    // exception is the whole traversal guard. `.` and `..` are made of nothing
    // but safe characters, so an encoder that admitted them would hand `join`
    // a segment that climbs out of the run directory — a guard that held only
    // because every real node id happens to contain an `@`. Escaping the first
    // dot makes it a property of the encoding instead of of the caller's
    // input, and costs a three-character prefix on the hidden-file spellings
    // nobody uses for a recipe.
    if (SAFE_KEY_CHAR.test(ch) && !(ch === "." && out === "")) {
      out += ch;
      continue;
    }
    // Per BYTE, not per code point: a multibyte character has no single
    // two-hex escape, and a per-code-point `~%04X` would be a second, wider
    // escape form for the decoder to disambiguate. UTF-8 bytes keep one form.
    for (const byte of new TextEncoder().encode(ch)) {
      out += `~${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** The inverse of {@link encodeNodeKey}, or `null` for a string that this
 *  encoding could not have produced (a stray `~`, a bad hex pair, bytes that
 *  are not valid UTF-8). Null rather than a lossy best effort: a directory the
 *  decoder cannot name is a directory a face must not claim to be showing. */
export function decodeNodeKey(key: string): string | null {
  // The encoder never emits a leading `.` (see above), so one here is not a
  // key this vocabulary produced — and admitting it would give `.` two
  // spellings, which is the injectivity the escape exists to keep.
  if (key.startsWith(".")) return null;
  const bytes: number[] = [];
  for (let i = 0; i < key.length; ) {
    const ch = key[i];
    if (ch === undefined) return null;
    if (ch !== "~") {
      // Safe characters are ASCII by construction, so one char is one byte.
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

// ── attempts ────────────────────────────────────────────────────────────────

/** An attempt ordinal is 1-based and dense per node: attempt 1 is the first
 *  time this run ran that node, and a rerun allocates the next. Zero and
 *  negatives are not "no attempt" — they are a caller error, because the
 *  absence of an attempt is spelled by not naming one. */
export function isAttemptOrdinal(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

/** The addressed identity of one piece of evidence: which run, which node,
 *  which attempt. The triple the spec addresses logs by, spelled once so a
 *  reader never assembles two of the three and hopes. */
export interface AttemptRef {
  runId: string;
  /** The fan-in node id (`<namepath>@<platform>`), DECODED — callers speak node
   *  ids and the store encodes at the path boundary. */
  node: string;
  attempt: number;
}

/** `<runId>/<node>#<attempt>` — the one display spelling for an attempt, used
 *  in refusals and in the attention payload so an agent can echo back exactly
 *  what it was shown. */
export function formatAttemptRef(ref: AttemptRef): string {
  return `${ref.runId}/${ref.node}#${ref.attempt}`;
}

// ── cursors ─────────────────────────────────────────────────────────────────

/**
 * A delivery cursor: how far through ONE run's journal a caller has been
 * served.
 *
 * Carrying the run id inside the cursor is what makes a wrong-run cursor
 * detectable instead of silently plausible. A bare offset is a number that is
 * valid against every run, so an agent that kept a cursor across a retry (a
 * finalized retry mints a NEW run — see the recovery table) would resume at
 * some unrelated position in the new run's journal and be told, truthfully,
 * that there was nothing new. The refusal it should get instead names the run
 * it was holding and the run it asked about, and the caller resyncs.
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

/** Parse a cursor token, or `null` when it is not one this vocabulary emitted.
 *  A caller's `null` is a REFUSAL (with a resync route), never a silent
 *  restart from zero: replaying a whole journal because a token was
 *  unreadable is how a duplicate alarm gets delivered as a new one. */
export function parseCursor(token: string): Cursor | null {
  const at = token.lastIndexOf("@");
  if (at <= 0) return null;
  const runId = token.slice(0, at);
  const tail = token.slice(at + 1);
  if (!isRunId(runId)) return null;
  // DIGITS, not `Number`. `Number("")` is 0, so a truncated token would have
  // read as the perfectly valid "nothing delivered yet" cursor and quietly
  // replayed a whole journal — and `Number` would equally have accepted
  // `0x10`, `1e3` and a leading space, none of which `formatCursor` can emit.
  // A cursor this vocabulary did not write is a refusal with a resync route.
  if (!/^\d+$/.test(tail)) return null;
  const seq = Number(tail);
  if (!Number.isSafeInteger(seq) || seq < 0) return null;
  return { runId, seq };
}

// ── run selectors ───────────────────────────────────────────────────────────

/**
 * What a person may type after `--run`.
 *
 * Three forms, because three are what an operator actually has to hand: the
 * word `latest` when they mean "the one I just started", the `<sha7>#<seq>`
 * ref every face already prints, and a run id (or a unique prefix of one) when
 * they are quoting something back. Parsing them here — rather than in the
 * argument parser — keeps the CLI and any later service face agreeing on what
 * `--run` accepts.
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
  // A prefix of a run id: base36 and dashes only, so it can never be a path
  // segment that means something else.
  if (!/^[0-9a-z-]{3,}$/.test(trimmed)) return null;
  return { kind: "id", value: trimmed };
}
