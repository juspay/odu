/**
 * A SURFACE'S FINGERPRINT, and the pin that holds a row's version to it.
 *
 * Every row versions its own surface (`Row.contract`), and the host versions its
 * own verbs and the admission cell. A version is only worth what enforces it: a
 * number nobody has to move when the surface moves is a promise that drifts. So
 * each row commits, beside its version, a hash of the surface that version
 * describes — and a test that recomputes it fails the moment the two disagree,
 * naming the row and the rule for the bump.
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

/** A row's committed pin: the version it publishes and the fingerprint of the
 *  surface that version describes. */
export interface ContractPin {
  readonly version: string;
  readonly fingerprint: string;
}

/**
 * HOLD A VERSION TO ITS SURFACE — `null` when the pin agrees, or the sentence
 * that says what to do.
 *
 * Three disagreements, three sentences: the surface moved and the version did
 * not (bump it, by the rule); the version moved and the pin did not (re-pin);
 * both moved (re-pin to the new pair). The rule is the one every row keeps: the
 * MINOR moves when the surface only GROWS, the MAJOR when something a reader
 * already uses CHANGES.
 */
export function contractPinMismatch(
  /** Who the version belongs to, as a sentence names it: "the cache row",
   *  "the host". */
  subject: string,
  constant: string,
  current: ContractPin,
  pinned: ContractPin,
): string | null {
  if (current.version === pinned.version && current.fingerprint === pinned.fingerprint) {
    return null;
  }
  const rule =
    "bump the MINOR if the surface only grew (a new verb, member, optional input " +
    "or ignorable output field), the MAJOR if it changes what a reader already " +
    "uses (a member removed or renamed, a required input added, an output field " +
    "removed or retyped)";
  const repin = `then pin { version: "${current.version}", fingerprint: "${current.fingerprint}" }`;
  if (current.version === pinned.version) {
    return (
      `${subject}'s surface changed but ${constant} is still ${current.version}: ` +
      `${rule}, then re-pin with the new version and fingerprint ${current.fingerprint}.`
    );
  }
  return (
    `${subject}'s ${constant} is ${current.version} but its pin says ${pinned.version} — ` +
    `${current.fingerprint === pinned.fingerprint ? "the surface did not change; a bump with nothing to version is a lie, so revert it or " : ""}` +
    `${repin}.`
  );
}
