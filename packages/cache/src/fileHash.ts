/**
 * A STORE'S FACTS, AS NIX SPELLS THEM — the one place they are translated.
 *
 * `@odu/objects` knows a size and a hex sha256 and nothing about Nix. A
 * narinfo's `FileHash` is `sha256:<nix base32>` of the same bytes. The cache
 * speaks `KeptFile` everywhere it records or compares, and crosses to the
 * store's facts here, in both directions, and nowhere else.
 */

import type { ObjectFacts } from "@odu/objects";
import { base32 } from "./narinfo";
import { base32Bytes } from "./storePath";

/** A kept object's facts, as a row and a narinfo carry them. */
export interface KeptFile {
  /** `sha256:<nix base32>` of the stored (compressed) bytes. */
  fileHash: string;
  fileSize: number;
}

export function keptFileOf(facts: ObjectFacts): KeptFile {
  return { fileHash: `sha256:${base32(Buffer.from(facts.sha256, "hex"))}`, fileSize: facts.size };
}

export function objectFactsOf(file: KeptFile): ObjectFacts {
  return {
    size: file.fileSize,
    sha256: Buffer.from(base32Bytes(file.fileHash.replace(/^sha256:/, ""))).toString("hex"),
  };
}
