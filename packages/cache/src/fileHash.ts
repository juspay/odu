import type { ObjectFacts } from "@odu/objects";
import { base32 } from "./narinfo";
import { base32Bytes } from "./storePath";

export interface KeptFile {
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
