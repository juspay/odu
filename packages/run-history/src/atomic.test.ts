/**
 * The two publication primitives, tested for what a CONCURRENT observer of the
 * directory can see.
 *
 * Both are one-liners wrapping a syscall, and both are easy to break in a way
 * no happy-path test notices. `writeAtomic` still writes the right bytes if the
 * rename is dropped for an in-place write — the tear only appears under a
 * SIGKILL — so the property pinned here is the observable trace instead: after
 * a write the directory holds the target and NOTHING else, including when the
 * publish failed halfway. `createExclusive` still returns something plausible
 * if `wx` is loosened to `w`, and the damage (a second caller truncating the
 * ownership fence it was supposed to lose to) shows up nowhere near the call.
 *
 * The failure modes matter as much as the successes: `false` from
 * `createExclusive` must mean "another writer won" and nothing else, or a
 * caller that retries on it retries forever against an unwritable directory.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { createExclusive, writeAtomic } from "./atomic";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-atomic-"));
  dirs.push(dir);
  return dir;
}

/** Root can write into a mode-0500 directory, so the EACCES case below is not
 *  a fact about the filesystem there. */
const unprivileged = process.getuid === undefined || process.getuid() !== 0;

describe("writeAtomic publishes a record", () => {
  it("creates the directories the record lives in", () => {
    // Callers hand over `<catalog>/<run>/attempts/<key>/<n>/record.json` with
    // none of it existing yet; a writer that had to mkdir first would be a
    // second place that knows the layout.
    const root = tmpRoot();
    const path = join(root, "runs", "12345678-abcd", "attempts", "k", "1", "record.json");
    writeAtomic(path, '{"ok":true}\n');
    expect(readFileSync(path, "utf8")).toBe('{"ok":true}\n');
  });

  it("replaces an existing record rather than merging with its bytes", () => {
    const root = tmpRoot();
    const path = join(root, "manifest.json");
    writeAtomic(path, `${"x".repeat(400)}\n`);
    // Shorter than what it replaces: an in-place write without truncation
    // would leave the old tail behind, and the result would still parse as
    // something for a forgiving reader to act on.
    writeAtomic(path, "short\n");
    expect(readFileSync(path, "utf8")).toBe("short\n");
  });

  it("leaves no temp file behind, so a reader listing the directory sees only records", () => {
    const root = tmpRoot();
    const path = join(root, "manifest.json");
    writeAtomic(path, "one\n");
    writeAtomic(path, "two\n");
    writeAtomic(join(root, "verdict.json"), "v\n");
    // A discovery pass is a `readdir`: a surviving `.<pid>-<tail>.tmp` would
    // be listed as a run's record, and a reader that opened it would be
    // reading exactly the half-written bytes the rename exists to hide.
    expect(readdirSync(root).sort()).toEqual(["manifest.json", "verdict.json"]);
  });

  it("cleans up its temp file and rethrows when the publish cannot land", () => {
    const root = tmpRoot();
    // A directory where the record should be — the rename has nowhere to go.
    // (Real cause, same shape: a full or read-only filesystem.)
    const path = join(root, "manifest.json");
    mkdirSync(path);
    writeFileSync(join(path, "inner"), "occupied\n");
    expect(() => writeAtomic(path, "new\n")).toThrow();
    // The failure must not leave litter that a later `readdir` reports as a
    // record, and it must not have disturbed what was already there.
    expect(readdirSync(root)).toEqual(["manifest.json"]);
    expect(statSync(path).isDirectory()).toBe(true);
    expect(readdirSync(path)).toEqual(["inner"]);
  });
});

describe("createExclusive is the whole of the concurrency control", () => {
  it("succeeds for exactly one caller at a path", () => {
    const root = tmpRoot();
    const path = join(root, "owner.json");
    expect(createExclusive(path, '{"pid":1}\n')).toBe(true);
    expect(createExclusive(path, '{"pid":2}\n')).toBe(false);
    expect(createExclusive(path, '{"pid":3}\n')).toBe(false);
  });

  it("does not touch the winner's bytes when it loses", () => {
    // The fence's whole value: the loser learns it lost AND the owner record
    // still names the winner. A `w` flag here would return true-then-true and
    // silently hand ownership to whoever ran last.
    const root = tmpRoot();
    const path = join(root, "owner.json");
    createExclusive(path, '{"pid":1}\n');
    createExclusive(path, "x\n");
    expect(readFileSync(path, "utf8")).toBe('{"pid":1}\n');
  });

  it("creates the parent directories it needs", () => {
    const root = tmpRoot();
    const path = join(root, "runs", "12345678-abcd", "attempts", "k", "2", "record.json");
    expect(createExclusive(path, "first\n")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("first\n");
  });

  it.skipIf(!unprivileged)(
    "rethrows anything that is not a lost race, so a caller cannot retry forever",
    () => {
      // Read-only directory: `false` here would tell an attempt allocator to
      // try the next ordinal, and the next, against a directory no ordinal
      // will ever be writable in.
      const root = tmpRoot();
      const locked = join(root, "locked");
      mkdirSync(locked);
      chmodSync(locked, 0o500);
      try {
        expect(() => createExclusive(join(locked, "owner.json"), "x\n")).toThrow(
          /EACCES/,
        );
      } finally {
        chmodSync(locked, 0o700);
      }
    },
  );
});
