/**
 * THE DISK IMPLEMENTATION, through the contract. The S3 store runs the same
 * suite in the phase that adds it; nothing here names a path the interface does
 * not own.
 */
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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

describe("disk object store details", () => {
  it("adopts a file by rename, and sweeps only old temp files", async () => {
    const store = diskObjectStore({ dir: scratch });
    const staged = join(scratch, "staged.nar.zst");
    writeFileSync(staged, "kept bytes");
    const facts = await store.adopt?.("main/nar/a.nar.zst", staged);
    expect(facts?.size).toBe(10);
    expect(existsSync(staged)).toBe(false);
    expect(await store.head("main/nar/a.nar.zst")).toBe(10);

    const old = join(scratch, "objects", "main", "nar", ".tmp-old");
    const young = join(scratch, "objects", "main", "nar", ".tmp-young");
    writeFileSync(old, "old");
    writeFileSync(young, "young");
    utimesSync(old, new Date(0), new Date(0));
    expect(await store.sweepTemp?.(Date.now() - 1_000)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(young)).toBe(true);
  });
});
