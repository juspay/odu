import { afterEach, expect, it } from "bun:test";
import { Effect } from "effect";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneClient } from "../common/laneSurface";
import { createSnapshotUploads } from "../runner/snapshotUpload";
import { uploadSnapshot } from "./snapshotTransport";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
it("ships >16 MiB in ordered 2 MiB chunks and skips upload only for an identical cache hit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odu-chunks-"));
  dirs.push(dir);
  const bytes = 17 * 1024 * 1024 + 13;
  const path = join(dir, "bundle");
  const content = Buffer.alloc(bytes, 42);
  writeFileSync(path, content);
  const uploads = createSnapshotUploads();
  const calls: string[] = [];
  const commit = "a".repeat(40);
  let present = false;
  const client = {
    snapshot: {
      has: (input: { origin: string; commit: string }) =>
        Effect.sync(() => {
          expect(input.commit).toBe(commit);
          expect(input.origin).toBe("file:///origin");
          calls.push("has");
          return { present };
        }),
      put: (input: Parameters<typeof uploads.put>[0]) =>
        Effect.sync(() => {
          calls.push(`put:${input.offset}`);
          expect(JSON.stringify(input).length).toBeLessThan(16 * 1024 * 1024);
          return uploads.put(input);
        }),
    },
  } as unknown as LaneClient["surface"];
  const snapshot = { commit, requires: [], bundlePath: path, bytes };
  try {
    expect(
      await uploadSnapshot(
        client,
        snapshot,
        "file:///origin",
        "host",
        () => {},
      ),
    ).toBe(true);
    expect(calls).toEqual([
      "has",
      ...Array.from({ length: 9 }, (_, i) => `put:${i * 2 * 1024 * 1024}`),
    ]);
    expect(readFileSync(uploads.path(commit)!)).toEqual(content);
    expect(uploads.path(commit)!.startsWith(join(tmpdir(), "odu", "snapshots"))).toBe(true);
    present = true;
    calls.length = 0;
    expect(
      await uploadSnapshot(
        client,
        snapshot,
        "file:///origin",
        "host",
        () => {},
      ),
    ).toBe(false);
    expect(calls).toEqual(["has"]);
    expect(
      uploads.put({ commit, offset: 0, total: bytes, data: "eA==" }).error,
    ).toContain("out-of-order");
  } finally {
    const uploaded = uploads.path(commit);
    uploads.dispose();
    if (uploaded !== null) expect(existsSync(uploaded)).toBe(false);
  }
});
it("rejects failed uploads and malformed staging inputs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "odu-chunks-"));
  dirs.push(dir);
  const path = join(dir, "bundle");
  writeFileSync(path, "x");
  const client = {
    snapshot: {
      has: () => Effect.succeed({ present: false }),
      put: () => Effect.succeed({ ok: false, error: "disk full", received: 0 }),
    },
  } as unknown as LaneClient["surface"];
  await expect(
    uploadSnapshot(
      client,
      { commit: "b".repeat(40), requires: [], bundlePath: path, bytes: 1 },
      "origin",
      "host",
      () => {},
    ),
  ).rejects.toThrow("disk full");
  const uploads = createSnapshotUploads();
  expect(
    uploads.put({ commit: "../bad", offset: 0, total: 1, data: "eA==" }).ok,
  ).toBe(false);
  expect(
    uploads.put({ commit: "a".repeat(40), offset: 0, total: 1, data: "???" })
      .ok,
  ).toBe(false);
  uploads.dispose();
});
