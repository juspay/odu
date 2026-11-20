import {
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";

export function compressionExtension(compression: string | null): string {
  switch (compression ?? "none") {
    case "none":
      return "nar";
    case "xz":
      return "nar.xz";
    case "bzip2":
      return "nar.bz2";
    default:
      return "nar.zst";
  }
}

export function narFileName(narHash: string, compression: string | null): string {
  return `${narHash.replace(/^sha256:/, "")}.${compressionExtension(compression)}`;
}

export function compressionOfFile(file: string): string | null {
  const at = file.indexOf(".nar");
  if (at === -1) return null;
  switch (file.slice(at)) {
    case ".nar":
      return "none";
    case ".nar.zst":
      return "zstd";
    case ".nar.xz":
      return "xz";
    case ".nar.bz2":
      return "bzip2";
    default:
      return null;
  }
}

export const SERVED_EXTENSION = "nar.zst";

/** Nix's base32 alphabet. NOT RFC 4648: no `e`, `o`, `u` or `t`. */
const BASE32_ALPHABET = "0123456789abcdfghijklmnpqrsvwxyz";

/** The DER prefixes ed25519 uses. A seed or a public key is these bytes plus
 *  the raw 32, and nothing else. */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
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
 *  base32 `sha256:<base32>` → the base32 part. */
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

export function canonicalNarHash(hash: string): string {
  return `sha256:${narHashBase32(hash)}`;
}

export function isStorePathHash(value: string): boolean {
  return /^[0-9abcdfghijklmnpqrsvwxyz]{32}$/.test(value);
}

export function keyParts(value: string): { name: string; payload: string } | null {
  const at = value.indexOf(":");
  return at <= 0 ? null : { name: value.slice(0, at), payload: value.slice(at + 1) };
}

export function keyNameOf(signature: string): string | null {
  return keyParts(signature)?.name ?? null;
}

export function isStagedFileName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && !value.includes("..");
}

export function storePathHash(storePath: string): string {
  const base = storePath.slice(storePath.lastIndexOf("/") + 1);
  const hash = base.slice(0, 32);
  if (!isStorePathHash(hash)) {
    throw new NarinfoError(`not a store path: ${storePath}`);
  }
  return hash;
}

/** NOT the name alone: Nix resolves a narinfo's `References` and `Deriver`
 *  against its store directory, and `hello-2.12.3` names nothing. */
export function storePathBasename(storePath: string): string {
  return storePath.slice(storePath.lastIndexOf("/") + 1);
}

export class NarinfoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NarinfoError";
  }
}

export interface NarInfo {
  storePath: string;
  url: string;
  compression: string | null;
  fileHash: string | null;
  fileSize: number | null;
  narHash: string;
  narSize: number;
  references: readonly string[];
  deriver: string | null;
  ca: string | null;
  sigs: readonly string[];
}

/** Unknown keys are ignored rather than refused: the format is Nix's to
 *  extend. */
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
  // `Deriver` is a basename on the wire.
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
    ca: one("CA"),
    sigs: fields.get("Sig") ?? [],
  };
}

/** `References` and `Deriver` are BASENAMES on the wire — Nix resolves them
 *  against its own store directory — so both are stripped here. */
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
    ...(info.ca === null ? [] : [`CA: ${info.ca}`]),
    ...info.sigs.map((sig) => `Sig: ${sig}`),
  ];
  return `${lines.join("\n")}\n`;
}

/** A derivation is a build recipe whose references are recipes, and fetching
 *  one lets Nix try to build it. */
export const isDerivationPath = (storePath: string): boolean => storePath.endsWith(".drv");

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

/** Generated from a random 32-byte SEED rather than from
 *  `generateKeyPairSync`'s key objects, because the seed is exactly what Nix's
 *  secret-key string is made of. */
export function generateKeypair(name: string): Keypair {
  const seed = randomBytes(32);
  const publicKey = rawPublicKey(seed);
  return {
    name,
    secretKey: `${name}:${Buffer.concat([seed, publicKey]).toString("base64")}`,
    publicKey: `${name}:${publicKey.toString("base64")}`,
  };
}

export function publicKeyOf(secretKey: string): string {
  const parts = keyParts(secretKey);
  if (parts === null) throw new NarinfoError("a secret key is <name>:<base64>");
  const raw = Buffer.from(parts.payload, "base64");
  if (raw.length !== 64) {
    throw new NarinfoError(`an ed25519 secret key is 64 bytes, got ${raw.length}`);
  }
  return `${parts.name}:${raw.subarray(32).toString("base64")}`;
}

export function signFingerprint(secretKey: string, fingerprint: string): string {
  const parts = keyParts(secretKey);
  if (parts === null) throw new NarinfoError("a secret key is <name>:<base64>");
  const raw = Buffer.from(parts.payload, "base64");
  if (raw.length !== 64) {
    throw new NarinfoError(`an ed25519 secret key is 64 bytes, got ${raw.length}`);
  }
  const signature = cryptoSign(
    null,
    Buffer.from(fingerprint, "utf8"),
    privateKeyFromSeed(raw.subarray(0, 32)),
  );
  return `${parts.name}:${signature.toString("base64")}`;
}

/** The NAME must match too: Nix selects the trusted key by it, so a signature
 *  carrying the wrong name is not a signature by that key. */
export function verifySignature(
  publicKey: string,
  fingerprint: string,
  signature: string,
): boolean {
  const publicParts = keyParts(publicKey);
  const sigParts = keyParts(signature);
  if (publicParts === null || sigParts === null || publicParts.name !== sigParts.name) return false;
  const raw = Buffer.from(publicParts.payload, "base64");
  const sig = Buffer.from(sigParts.payload, "base64");
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
