/**
 * A SURFACE'S FINGERPRINT, and the pin that holds a row's version to it.
 *
 * Every row versions its own surface (`Row.contract`), and the host versions its
 * own verbs and the admission cell. A version is only worth what enforces it: a
 * number nobody has to move when the surface moves is a promise that drifts. So
 * each row commits an append-only LEDGER — every version it published, each
 * with a hash of the surface it described — and a test that recomputes the hash
 * fails the moment the current version's line disagrees, naming the row and the
 * rule for the bump.
 *
 * A dependency bump that changes the JSON Schema Effect derives moves every
 * fingerprint with no surface change: that case re-pins the CURRENT line and
 * says why in its commit.
 *
 * **What is hashed.** The surface's SPEC, walked with sorted keys: every cell,
 * collection, stream and procedure, its verbs and defaults, and every schema as
 * the JSON Schema document Effect derives from it — which is what a reader
 * decodes against. Then the wire tags the spec mints, and the row's exposure
 * policy (what an agent may reach, and whether it mutates). A comment is not in
 * it; a description annotation is, because a reader sees it.
 *
 * Pure, and no `node:` builtin: this package is a contract the browser imports,
 * so the hash is FNV-1a over 64 bits in plain arithmetic. It need not resist an
 * adversary — it must only change when the surface does.
 */

import { Schema } from "effect";

/** Anything a surface spec holds, made canonical: sorted keys, schemas as JSON
 *  Schema documents, functions as a marker (a handler is not a contract). */
function canonical(value: unknown): unknown {
  if (Schema.isSchema(value)) {
    return { schema: Schema.toJsonSchemaDocument(value as Schema.Top) };
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "function") return "<function>";
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** FNV-1a, 64-bit, over the UTF-16 code units of `text`, as 16 hex digits. */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

/** What a fingerprint is taken over: a spec, the tags it mints, and the
 *  exposure policy. Structural, so the host can hash a fragment that is not one
 *  `defineSurface` (its control surface plus the identity cell). */
export interface SurfaceShape {
  readonly spec: unknown;
  readonly tags: ReadonlyArray<string>;
  readonly expose?: unknown;
}

/** The fingerprint of one surface — stable across runs and machines, and moved
 *  by any change a reader could observe. */
export function surfaceFingerprint(shape: SurfaceShape): string {
  return fnv1a64(
    JSON.stringify({
      spec: canonical(shape.spec),
      tags: [...shape.tags].sort(),
      expose: canonical(shape.expose ?? null),
    }),
  );
}

/** The tags a surface's group carries — the wire spelling of every member. */
export function surfaceTags(surface: {
  readonly group: { readonly requests: ReadonlyMap<string, unknown> };
}): ReadonlyArray<string> {
  return [...surface.group.requests.keys()];
}

/**
 * ONE ROW'S SHAPE — its surface and exposure, less the members it SERVES but
 * does not own.
 *
 * `omit` exists for one member: the identity cell, which every deployed reader
 * dials on the runs' root surface but whose shape is the HOST's contract. It is
 * taken out of the runs' fingerprint (and its tags and exposure with it) and put
 * into the host's, so each fact is versioned exactly once.
 */
export function rowShape(
  surface: {
    readonly spec: object;
    readonly group: { readonly requests: ReadonlyMap<string, unknown> };
  },
  expose: object,
  omit: ReadonlyArray<string> = [],
): SurfaceShape {
  const dropped = new Set(omit);
  const spec = Object.fromEntries(
    Object.entries(surface.spec).map(([section, members]) => [
      section,
      Object.fromEntries(
        Object.entries(members as Record<string, unknown>).filter(([name]) => !dropped.has(name)),
      ),
    ]),
  );
  return {
    spec,
    tags: surfaceTags(surface).filter(
      (tag) => !omit.some((name) => tag.startsWith(`surface/${name}/`)),
    ),
    expose: Object.fromEntries(Object.entries(expose).filter(([name]) => !dropped.has(name))),
  };
}

/**
 * A ROW'S LEDGER — every version it has published, in order, each with the
 * fingerprint of the surface that version described. APPEND-ONLY: a bump adds a
 * last line, and no existing line is ever edited. That is what makes the lie
 * visible: "fixing" a red test by rewriting the current fingerprint while
 * leaving the version alone shows in the diff as an edited historical line,
 * which a reviewer reads as a surface change shipped under an old number.
 *
 * Keys are `major.minor`, never integers, so the object keeps insertion order.
 */
export type ContractLedger = Readonly<Record<string, string>>;

function versionOrder(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

/**
 * HOLD A VERSION TO ITS LEDGER — `null` when the current version is the
 * ledger's last line and its fingerprint is the surface's, or the sentence that
 * says what to do.
 *
 * The rule every row keeps: the MINOR moves when the surface only GROWS, the
 * MAJOR when something a reader already uses CHANGES.
 *
 * ONE HONEST REWRITE: a dependency bump that changes the JSON Schema Effect
 * derives moves every fingerprint with no surface change. Then re-pin the
 * CURRENT line — the only line that may ever be edited — and say why in the
 * commit.
 */
export function contractLedgerMismatch(
  /** Who the version belongs to, as a sentence names it: "the cache row",
   *  "the host". */
  subject: string,
  constant: string,
  current: { readonly version: string; readonly fingerprint: string },
  ledger: ContractLedger,
): string | null {
  const versions = Object.keys(ledger);
  for (let i = 1; i < versions.length; i++) {
    if (versionOrder(versions[i - 1] as string, versions[i] as string) >= 0) {
      return (
        `${subject}'s ledger is out of order at ${versions[i]}: it is append-only, ` +
        "each line a later version than the one before."
      );
    }
  }
  const last = versions[versions.length - 1];
  const line = `"${current.version}": "${current.fingerprint}"`;
  if (last === undefined) {
    return `${subject}'s ledger is empty: add its first line, ${line}.`;
  }
  if (current.version !== last) {
    if (current.version in ledger) {
      return (
        `${subject}'s ${constant} is ${current.version}, an OLDER line of its ledger ` +
        `(the last is ${last}) — a version never moves backwards.`
      );
    }
    return (
      `${subject}'s ${constant} is ${current.version} but its ledger ends at ${last}: ` +
      `APPEND ${line} as its last line` +
      (ledger[last] === current.fingerprint
        ? " — though the surface did not change, so a bump with nothing to version is a lie; revert it."
        : ".")
    );
  }
  if (ledger[last] === current.fingerprint) return null;
  return (
    `${subject}'s surface changed but ${constant} is still ${current.version}. ` +
    "Bump the MINOR if the surface only grew (a new verb, member, optional input or " +
    "ignorable output field), the MAJOR if it changes what a reader already uses (a " +
    "member removed or renamed, a required input added, an output field removed or " +
    "retyped), and APPEND the new version's line with fingerprint " +
    `${current.fingerprint}. Never rewrite the ${current.version} line — an edited ` +
    "historical line is a surface change shipped under an old number — unless a " +
    "dependency bump moved Effect's JSON Schema output with no surface change; then " +
    "re-pin this line and say so in the commit."
  );
}
