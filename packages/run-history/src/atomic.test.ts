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
    const root = tmpRoot();
    const path = join(root, "runs", "12345678-abcd", "attempts", "k", "1", "record.json");
    writeAtomic(path, '{"ok":true}\n');
    expect(readFileSync(path, "utf8")).toBe('{"ok":true}\n');
  });

  it("replaces an existing record rather than merging with its bytes", () => {
    const root = tmpRoot();
    const path = join(root, "manifest.json");
    writeAtomic(path, `${"x".repeat(400)}\n`);
    writeAtomic(path, "short\n");
    expect(readFileSync(path, "utf8")).toBe("short\n");
  });

  it("leaves no temp file behind, so a reader listing the directory sees only records", () => {
    const root = tmpRoot();
    const path = join(root, "manifest.json");
    writeAtomic(path, "one\n");
    writeAtomic(path, "two\n");
    writeAtomic(join(root, "verdict.json"), "v\n");
    expect(readdirSync(root).sort()).toEqual(["manifest.json", "verdict.json"]);
  });

  it("cleans up its temp file and rethrows when the publish cannot land", () => {
    const root = tmpRoot();
    const path = join(root, "manifest.json");
    mkdirSync(path);
    writeFileSync(join(path, "inner"), "occupied\n");
    expect(() => writeAtomic(path, "new\n")).toThrow();
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
