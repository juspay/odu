import { Schema } from "effect";

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

export function surfaceTags(surface: {
  readonly group: { readonly requests: ReadonlyMap<string, unknown> };
}): ReadonlyArray<string> {
  return [...surface.group.requests.keys()];
}

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

export type ContractLedger = Readonly<Record<string, string>>;

function versionOrder(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

/**
 * `null` when the current version is the ledger's last line and its fingerprint
 * is the surface's, or the sentence that says what to do.
 */
export function contractLedgerMismatch(
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
