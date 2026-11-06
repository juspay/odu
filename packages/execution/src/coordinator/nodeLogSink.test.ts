/**
 * appendIfOpen is the coordinator's sealed-log skip. Removing the isEnded
 * guard here must fail this file: every append path (tap frame, lane-death
 * line, setup narration, truncation stamp) shares it.
 *
 * And the sink addresses a node's TWO logs — the recipe's and the push's —
 * by stream, which is two files and two terminals, never one of each.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { logPathFor, logPathForStream } from "@odu/run-client/nodeId";
import { appendIfOpen, createNodeLogSink } from "./nodeLogSink";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("appendIfOpen", () => {
  it("is a no-op on a sealed log — and the sink still throws on a direct append", () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-sink-"));
    dirs.push(dir);
    const sink = createNodeLogSink(dir, "abc1234");
    const id = "fast@x86_64-linux";
    sink.append(id, "hello\n");
    sink.end(id);

    expect(() =>
      appendIfOpen(sink, id, "log stream error: EPIPE\n"),
    ).not.toThrow();
    expect(readFileSync(join(dir, logPathFor("abc1234", id)), "utf-8")).toBe(
      "hello\n",
    );

    expect(() => sink.append(id, "direct\n")).toThrow(/after its log ended/);
  });

  it("writes when the log is still open", () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-sink-"));
    dirs.push(dir);
    const sink = createNodeLogSink(dir, "abc1234");
    const id = "slow@x86_64-linux";
    appendIfOpen(sink, id, "running\n");
    expect(readFileSync(join(dir, logPathFor("abc1234", id)), "utf-8")).toBe(
      "running\n",
    );
  });
});

describe("a node's two durable logs", () => {
  it("keeps the recipe's bytes and the push's in separate files", () => {
    // The whole point of the second stream: a recipe's log is worth exactly
    // its promise to hold the recipe's output. One file per stream is what
    // makes that promise keepable on disk as well as on the wire.
    const dir = mkdtempSync(join(tmpdir(), "odu-sink-"));
    dirs.push(dir);
    const sink = createNodeLogSink(dir, "abc1234");
    const id = "build@x86_64-linux";

    sink.append(id, "compiling\n");
    sink.append(id, "[odu] pushing 2 result paths\n", "push");

    expect(readFileSync(join(dir, logPathForStream("abc1234", id)), "utf-8")).toBe(
      "compiling\n",
    );
    expect(
      readFileSync(join(dir, logPathForStream("abc1234", id, "push")), "utf-8"),
    ).toBe("[odu] pushing 2 result paths\n");
  });

  it("seals one stream without sealing the other", () => {
    // A node's two logs end together in practice — the runner ends them in
    // lockstep — but the SINK must not conflate them: a push that is still
    // uploading when the recipe's terminal lands would otherwise have its
    // remaining lines dropped by `appendIfOpen` or kill the coordinator
    // through `append`'s deliberate throw.
    const dir = mkdtempSync(join(tmpdir(), "odu-sink-"));
    dirs.push(dir);
    const sink = createNodeLogSink(dir, "abc1234");
    const id = "build@x86_64-linux";

    sink.end(id);
    expect(sink.isEnded(id)).toBe(true);
    expect(sink.isEnded(id, "push")).toBe(false);

    appendIfOpen(sink, id, "too late\n");
    appendIfOpen(sink, id, "[odu] 4 paths sent\n", "push");
    expect(
      readFileSync(join(dir, logPathForStream("abc1234", id, "push")), "utf-8"),
    ).toBe("[odu] 4 paths sent\n");
    expect(() => sink.append(id, "direct\n")).toThrow(/after its log ended/);
  });
});
