/**
 * **The formula.** `makeStorePath(type, hash, name)` fingerprints
 * `type:sha256:<hex hash>:/nix/store:<name>`, sha256s it, folds 32 bytes onto
 * 20 (`compressHash`), and encodes Nix's base32. For a recursive fixed output,
 * `type` is `source` followed by `:` and each reference **full store path**, in
 * sorted order; a self-reference is the literal `self`.
 *
 * **A SELF-REFERENCE IS PROVED FROM ITS BYTES.** Its CA hash is Nix's hash of
 * the NAR with the path's own hash part replaced by zeros (Nix 2.34 records no
 * match positions, so there is no `|pos` fold).
 */

import { createHash } from "node:crypto";
import { base32, NarinfoError, narHashBase32 } from "./narinfo";

const BASE32_ALPHABET = "0123456789abcdfghijklmnpqrsvwxyz";

export function base32Bytes(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  for (let k = 0; k < text.length; k++) {
    const value = BASE32_ALPHABET.indexOf(text[text.length - 1 - k] as string);
    if (value < 0) throw new NarinfoError(`not a Nix base32 string: ${text}`);
    for (let j = 0; j < 5; j++) {
      if (((value >> j) & 1) === 0) continue;
      const bit = k * 5 + j;
      out[Math.floor(bit / 8)]! |= 1 << (bit % 8);
    }
  }
  return out;
}

function compressHash(hash: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < hash.length; i++) out[i % size]! ^= hash[i] as number;
  return out;
}

export function storePathHashOf(type: string, hash: Uint8Array, name: string): string {
  const fingerprint = `${type}:sha256:${Buffer.from(hash).toString("hex")}:/nix/store:${name}`;
  const digest = createHash("sha256").update(fingerprint).digest();
  return base32(compressHash(digest, 20));
}

/**
 * A self-referencing NAR's hash modulo its own hash part, in both forms
 * released Nix writes (see `narHashModuloHasher`): Nix 2.17 through 2.34 hash
 * the zeroed bytes alone, Nix 2.35 and later follow them with each
 * occurrence's `|<offset>`. Each is `sha256:<nix base32>`.
 */
export interface SelfHashes {
  withoutOffsets: string;
  withOffsets: string;
}

export type SelfProof =
  | { kind: "computed"; hashes: SelfHashes }
  | { kind: "unread" }
  | { kind: "none" };

export const selfReferencing = (storePath: string, references: readonly string[]): boolean =>
  references.includes(storePath);

type SelfHashForm = keyof SelfHashes;

const SELF_HASH_FORMS: readonly SelfHashForm[] = ["withoutOffsets", "withOffsets"];

export function contentAddressOf(input: {
  storePath: string;
  narHash: string;
  references: readonly string[];
  selfHash?: SelfHashes | null;
}): string | null {
  const path = input.storePath;
  if (!path.startsWith("/nix/store/")) return null;
  const base = path.slice("/nix/store/".length);
  const dash = base.indexOf("-");
  if (dash !== 32) return null;
  const name = base.slice(dash + 1);
  if (name === "") return null;
  const references = input.references.map((reference) =>
    reference.startsWith("/nix/store/") ? reference : `/nix/store/${reference}`,
  );
  const self = references.includes(path);
  const refs = self
    ? references.map((reference) => (reference === path ? "self" : reference))
    : references;
  const type = refs.length === 0 ? "source" : `source:${[...refs].sort().join(":")}`;
  const provesStorePath = (hash: string): string | null => {
    let nar: string;
    try {
      nar = narHashBase32(`sha256:${hash}`);
    } catch {
      return null;
    }
    const candidate = `/nix/store/${storePathHashOf(type, base32Bytes(nar), name)}-${name}`;
    return candidate === path ? `fixed:r:sha256:${nar}` : null;
  };
  if (self) {
    const selfHash = input.selfHash;
    if (selfHash === undefined || selfHash === null) return null;
    for (const form of SELF_HASH_FORMS) {
      const modulo = /^sha256:([0-9abcdfghijklmnpqrsvwxyz]{52})$/.exec(selfHash[form]);
      const proved = modulo === null ? null : provesStorePath(modulo[1] as string);
      if (proved !== null) return proved;
    }
    return null;
  }
  let nar: string;
  try {
    nar = narHashBase32(input.narHash);
  } catch {
    return null;
  }
  const candidate = `/nix/store/${storePathHashOf(type, base32Bytes(nar), name)}-${name}`;
  return candidate === path ? `fixed:r:sha256:${nar}` : null;
}
