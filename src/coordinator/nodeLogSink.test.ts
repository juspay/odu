/**
 * appendIfOpen is the coordinator's sealed-log skip. Removing the isEnded
 * guard here must fail this file: every append path (tap frame, lane-death
 * line, setup narration, truncation stamp) shares it.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { logPathFor } from "@odu/run-client/nodeId";
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
