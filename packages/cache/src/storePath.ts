/**
 * A STORE PATH PROVES ITS OWN CONTENT ADDRESS, when Nix's formula says so.
 *
 * A path rewritten by `nix store make-content-addressed` is
 * `fixed:r:sha256:<hash>`; Nix derives its store path from (name, that hash,
 * references, self-reference), so the ROW — which already holds the path, the
 * narHash and the references — can recompute the candidate and accept it only
 * when it equals the path. No pusher line and no store query are trusted.
 *
 * **The formula.** `makeStorePath(type, hash, name)` fingerprints
 * `type:sha256:<hex hash>:/nix/store:<name>`, sha256s it, folds 32 bytes onto
 * 20 (`compressHash`), and encodes Nix's base32. For a recursive fixed output,
 * `type` is `source` followed by `:` and each reference **full store path**, in
 * sorted order; a self-reference is the literal `self`.
 *
 * **A SELF-REFERENCE IS PROVED FROM ITS BYTES.** Its CA hash is Nix's hash of
 * the NAR with the path's own hash part replaced by zeros (Nix 2.34 records no
 * match positions, so there is no `|pos` fold); the server computes that while
 * verifying the object. The pusher's `CA:` line is parsed and IGNORED: a fact
 * about an object we hold must not depend on who pushed it or when.
 */

import { createHash } from "node:crypto";
import { base32, NarinfoError, narHashBase32 } from "./narinfo";

const BASE32_ALPHABET = "0123456789abcdfghijklmnpqrsvwxyz";

/** nix's `printHash32` inverse: five-bit groups read from the least significant
 *  end of the byte array. */
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

/** Nix's `compressHash`: fold every byte onto a smaller result. */
function compressHash(hash: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < hash.length; i++) out[i % size]! ^= hash[i] as number;
  return out;
}

/** `makeStorePath`'s hash part, as the 32 characters a path carries. */
export function storePathHashOf(type: string, hash: Uint8Array, name: string): string {
  const fingerprint = `${type}:sha256:${Buffer.from(hash).toString("hex")}:/nix/store:${name}`;
  const digest = createHash("sha256").update(fingerprint).digest();
  return base32(compressHash(digest, 20));
}

/**
 * The row's `CA:` line, PROVED by recomputing the path it must have produced;
 * `null` when Nix's formula does not reproduce the row's path. Never guesses.
 */
export function contentAddressOf(input: {
  storePath: string;
  narHash: string;
  references: readonly string[];
  /** The modulo-self hash computed from the NAR (self-referencing rows). */
  selfHash?: string | null;
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
  const proves = (hash: string): string | null => {
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
    const modulo = /^sha256:([0-9abcdfghijklmnpqrsvwxyz]{52})$/.exec(input.selfHash ?? "");
    return modulo === null ? null : proves(modulo[1] as string);
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
