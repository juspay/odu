/**
 * NARINFO — the text format, the fingerprint Nix signs, and the key format.
 *
 * Three things live here because they are one subject: what a narinfo SAYS, what
 * a signature over it is computed over, and how a key is spelled. Splitting them
 * would let a writer change one without the others, and the failure that
 * produces is the quiet one — a signature that verifies against a fingerprint
 * nobody else computes, so odu is happy and every Nix client says "not signed
 * by any of the keys in 'trusted-public-keys'".
 *
 * **The fingerprint is Nix's, not ours.** `1;<storePath>;<narHash>;<narSize>;<refs>`
 * with the references COMMA-joined and in the order the narinfo lists them. The
 * `1` is Nix's format version and it has never been anything else.
 *
 * **The hash spelling is converted, not guessed.** `nix path-info --json`
 * reports `narHash` as SRI (`sha256-<base64>`); a narinfo is written with
 * `sha256:<base32>` and the NAR's URL is named for that base32. Nix's base32 is
 * NOT RFC 4648 — the alphabet omits `e`, `o`, `u` and `t`, and the five-bit
 * groups are read from the least significant end of the byte array while the
 * digits come out most significant first. {@link base32} is that algorithm
 * verbatim; it is checked against a real narinfo from cache.nixos.org in the
 * suite, because getting it wrong is invisible until a client tries to
 * substitute.
 *
 * **Keys are Nix's spelling.** A secret key is `<name>:<base64 64 bytes>` — a
 * 32-byte ed25519 seed followed by its public key — and a public key is
 * `<name>:<base64 32 bytes>`. A signature is `<name>:<base64 64 bytes>`. The
 * seed is the part that matters: `node:crypto` has no "give me the raw seed"
 * API, so a key is built by wrapping the seed in the fixed PKCS#8 envelope
 * ed25519 uses (`302e020100300506032b657004220420`), which is how every
 * implementation of this format does it.
 */

import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";

/** Nix's base32 alphabet. NOT RFC 4648: no `e`, `o`, `u` or `t`. */
const BASE32_ALPHABET = "0123456789abcdfghijklmnpqrsvwxyz";

/** The DER prefixes ed25519 uses. A seed or a public key is these bytes plus
 *  the raw 32, and nothing else. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Nix's base32, as Nix computes it.
 *
 * The loop is Nix's own (`printHash32`): five-bit groups are taken from bit
 * position `5k` of the byte array read LITTLE-endian (byte `i`, shift `j`),
 * and emitted for `k` descending — so the most significant group comes first
 * and the string is the plain base-32 numeral of the big-endian integer.
 */
export function base32(bytes: Uint8Array): string {
  const length = Math.ceil((bytes.length * 8) / 5);
  let out = "";
  for (let k = length - 1; k >= 0; k--) {
    const bit = k * 5;
    const i = Math.floor(bit / 8);
    const j = bit % 8;
    const low = bytes[i] ?? 0;
    const high = i >= bytes.length - 1 ? 0 : (bytes[i + 1] ?? 0);
    out += BASE32_ALPHABET[((low >> j) | (high << (8 - j))) & 0x1f] ?? "0";
  }
  return out;
}

/** A `sha256-<base64>` SRI hash (what `nix path-info` reports) or an already
 *  base32 `sha256:<base32>` → the base32 part. Anything else is refused: a
 *  narinfo written with a hash Nix cannot parse is a 404 for every client. */
export function narHashBase32(hash: string): string {
  const sri = /^sha256-(.+)$/.exec(hash);
  if (sri !== null) {
    const bytes = Buffer.from(sri[1] as string, "base64");
    if (bytes.length !== 32) {
      throw new NarinfoError(`not a sha256 hash: ${hash}`);
    }
    return base32(bytes);
  }
  const nix = /^sha256:([0-9abcdfghijklmnpqrsvwxyz]{52})$/.exec(hash);
  if (nix !== null) return nix[1] as string;
  throw new NarinfoError(`not a sha256 hash: ${hash}`);
}

/** The canonical narinfo spelling of a hash, whichever form it arrived in. */
export function canonicalNarHash(hash: string): string {
  return `sha256:${narHashBase32(hash)}`;
}

/** Is this the 32-character hash a narinfo is named for? The alphabet is Nix's,
 *  so this refuses `..`, `%2F` and everything else a route parameter can be
 *  decoded into — it is the wall in front of every `join()` in the cache. */
export function isStorePathHash(value: string): boolean {
  return /^[0-9abcdfghijklmnpqrsvwxyz]{32}$/.test(value);
}

/** The KEY NAME a signature carries — `cache.nixos.org-1` out of
 *  `cache.nixos.org-1:base64…` — or null when there is no colon at all.
 *
 *  Shared by every caller that asks "is this signature by that key": a
 *  `slice(0, indexOf(":"))` answers -1 with the whole string minus its last
 *  character, which is a key name that matches nothing and silently defeats the
 *  upstream filter.
 */
export function keyNameOf(signature: string): string | null {
  const at = signature.indexOf(":");
  return at <= 0 ? null : signature.slice(0, at);
}

/** Is this a file name odu will stage? No leading dot (so `.` and `..` are
 *  refused), no slash, no percent — a NAR's name comes from a URL the CLIENT
 *  chose. */
export function isStagedFileName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes("..");
}

/** A store path's hash part — the 32 characters after `/nix/store/`, which is
 *  what a narinfo is named for and what a bucket indexes a path by. */
export function storePathHash(storePath: string): string {
  const base = storePath.slice(storePath.lastIndexOf("/") + 1);
  const hash = base.slice(0, 32);
  if (!isStorePathHash(hash)) {
    throw new NarinfoError(`not a store path: ${storePath}`);
  }
  return hash;
}

/** A store path's BASENAME — `<hash>-<name>`, the spelling a narinfo's
 *  `References` and `Deriver` fields use. NOT the name alone: Nix resolves these
 *  against its store directory, and `hello-2.12.3` names nothing. */
export function storePathBasename(storePath: string): string {
  return storePath.slice(storePath.lastIndexOf("/") + 1);
}

/** Thrown for anything malformed. The routes turn it into a 400: a narinfo
 *  odu cannot parse is the CLIENT's error, never a crash. */
export class NarinfoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NarinfoError";
  }
}

/** One parsed narinfo. `fileHash`/`fileSize` are carried but never produced by
 *  odu: it compresses on the fly, so it does not know the served file's hash,
 *  and Nix verifies `narHash` over the decompressed NAR regardless. */
export interface NarInfo {
  storePath: string;
  url: string;
  compression: string | null;
  fileHash: string | null;
  fileSize: number | null;
  /** `sha256:<base32>` — canonical, whatever spelling arrived. */
  narHash: string;
  narSize: number;
  /** FULL store paths, in narinfo order. */
  references: readonly string[];
  deriver: string | null;
  sigs: readonly string[];
}

/** Parse a narinfo. Unknown keys are ignored rather than refused: the format is
 *  Nix's to extend, and a pusher's `CA:` line is not odu's business. */
export function parseNarinfo(text: string): NarInfo {
  const fields = new Map<string, string[]>();
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    const list = fields.get(key);
    if (list === undefined) fields.set(key, [value]);
    else list.push(value);
  }
  const one = (key: string): string | null => fields.get(key)?.[0] ?? null;
  const storePath = one("StorePath");
  if (storePath === null) throw new NarinfoError("narinfo has no StorePath");
  const narHashRaw = one("NarHash");
  if (narHashRaw === null) throw new NarinfoError("narinfo has no NarHash");
  const narSizeRaw = one("NarSize");
  if (narSizeRaw === null) throw new NarinfoError("narinfo has no NarSize");
  const narSize = Number(narSizeRaw);
  if (!Number.isSafeInteger(narSize) || narSize < 0) {
    throw new NarinfoError(`narinfo has a bad NarSize: ${narSizeRaw}`);
  }
  const fileSizeRaw = one("FileSize");
  // `Deriver` is a basename on the wire and a full store path everywhere else
  // in this package — the same normalisation `References` gets, for the same
  // reason: a row that held both spellings would need every reader to know
  // which one it had.
  const deriverRaw = one("Deriver");
  return {
    storePath,
    url: one("URL") ?? "",
    compression: one("Compression"),
    fileHash: one("FileHash"),
    fileSize: fileSizeRaw === null ? null : Number(fileSizeRaw),
    narHash: canonicalNarHash(narHashRaw),
    narSize,
    references: (one("References") ?? "")
      .split(" ")
      .filter((s) => s !== "")
      .map((name) => `/nix/store/${name}`),
    deriver:
      deriverRaw === null || deriverRaw === ""
        ? null
        : deriverRaw.startsWith("/")
          ? deriverRaw
          : `/nix/store/${deriverRaw}`,
    sigs: fields.get("Sig") ?? [],
  };
}

/** Write a narinfo. `References` and `Deriver` are BASENAMES on the wire — Nix
 *  resolves them against its own store directory — so both are stripped here
 *  rather than at every call site. */
export function formatNarinfo(info: NarInfo): string {
  const lines = [
    `StorePath: ${info.storePath}`,
    `URL: ${info.url}`,
    ...(info.compression === null ? [] : [`Compression: ${info.compression}`]),
    ...(info.fileHash === null ? [] : [`FileHash: ${info.fileHash}`]),
    ...(info.fileSize === null ? [] : [`FileSize: ${info.fileSize}`]),
    `NarHash: ${info.narHash}`,
    `NarSize: ${info.narSize}`,
    `References: ${info.references.map(storePathBasename).join(" ")}`,
    ...(info.deriver === null ? [] : [`Deriver: ${storePathBasename(info.deriver)}`]),
    ...info.sigs.map((sig) => `Sig: ${sig}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** What a signature is computed over — Nix's `fingerprintPath`, verbatim. */
export function fingerprintOf(info: {
  storePath: string;
  narHash: string;
  narSize: number;
  references: readonly string[];
}): string {
  return [
    "1",
    info.storePath,
    canonicalNarHash(info.narHash),
    String(info.narSize),
    info.references.join(","),
  ].join(";");
}

/** A bucket's keypair, in Nix's spelling. */
export interface Keypair {
  name: string;
  /** `<name>:<base64 64 bytes>` */
  secretKey: string;
  /** `<name>:<base64 32 bytes>` */
  publicKey: string;
}

function privateKeyFromSeed(seed: Buffer) {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
}

function rawPublicKey(seed: Buffer): Buffer {
  const spki = createPublicKey(privateKeyFromSeed(seed)).export({
    format: "der",
    type: "spki",
  }) as Buffer;
  return spki.subarray(SPKI_ED25519_PREFIX.length);
}

/** A fresh ed25519 keypair. Generated from a random 32-byte SEED rather than
 *  from `generateKeyPairSync`'s key objects, because the seed is exactly what
 *  Nix's secret-key string is made of. */
export function generateKeypair(name: string): Keypair {
  const seed = randomBytes(32);
  const publicKey = rawPublicKey(seed);
  return {
    name,
    secretKey: `${name}:${Buffer.concat([seed, publicKey]).toString("base64")}`,
    publicKey: `${name}:${publicKey.toString("base64")}`,
  };
}

/** The public half of a secret key, in Nix's spelling. */
export function publicKeyOf(secretKey: string): string {
  const at = secretKey.indexOf(":");
  if (at <= 0) throw new NarinfoError("a secret key is <name>:<base64>");
  const name = secretKey.slice(0, at);
  const raw = Buffer.from(secretKey.slice(at + 1), "base64");
  if (raw.length !== 64) {
    throw new NarinfoError(`an ed25519 secret key is 64 bytes, got ${raw.length}`);
  }
  return `${name}:${raw.subarray(32).toString("base64")}`;
}

/** Sign a fingerprint with a secret key, answering `<name>:<base64 64>`. */
export function signFingerprint(secretKey: string, fingerprint: string): string {
  const at = secretKey.indexOf(":");
  if (at <= 0) throw new NarinfoError("a secret key is <name>:<base64>");
  const name = secretKey.slice(0, at);
  const raw = Buffer.from(secretKey.slice(at + 1), "base64");
  if (raw.length !== 64) {
    throw new NarinfoError(`an ed25519 secret key is 64 bytes, got ${raw.length}`);
  }
  const signature = cryptoSign(null, Buffer.from(fingerprint, "utf8"), privateKeyFromSeed(raw.subarray(0, 32)));
  return `${name}:${signature.toString("base64")}`;
}

/** Verify a `<name>:<base64 64>` signature against a `<name>:<base64 32>`
 *  public key. The NAME must match too: Nix selects the trusted key by it, so a
 *  signature carrying the wrong name is not a signature by that key. */
export function verifySignature(
  publicKey: string,
  fingerprint: string,
  signature: string,
): boolean {
  const keyAt = publicKey.indexOf(":");
  const sigAt = signature.indexOf(":");
  if (keyAt <= 0 || sigAt <= 0) return false;
  if (publicKey.slice(0, keyAt) !== signature.slice(0, sigAt)) return false;
  const raw = Buffer.from(publicKey.slice(keyAt + 1), "base64");
  const sig = Buffer.from(signature.slice(sigAt + 1), "base64");
  if (raw.length !== 32 || sig.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
    return cryptoVerify(null, Buffer.from(fingerprint, "utf8"), key, sig);
  } catch {
    return false;
  }
}
