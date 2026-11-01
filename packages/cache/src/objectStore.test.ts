/**
 * THE DISK IMPLEMENTATION, through the contract. The S3 store runs the same
 * suite in the phase that adds it; nothing here names a path the interface does
 * not own.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe } from "bun:test";
import { objectStoreContract } from "../test/objectStore.contract";
import { diskObjectStore } from "./objectStore";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "odu-object-store-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

objectStoreContract("disk", async () => ({
  store: diskObjectStore({ dir: scratch }),
  dispose: async () => {},
}));

describe("disk object store", () => {});
