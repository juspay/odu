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
      appendIfOpen(
        sink,
        { nodeId: id, stream: "recipe" },
        "log stream error: EPIPE\n",
      ),
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
    appendIfOpen(sink, { nodeId: id, stream: "recipe" }, "running\n");
    expect(readFileSync(join(dir, logPathFor("abc1234", id)), "utf-8")).toBe(
      "running\n",
    );
  });
});

describe("a node's two durable logs", () => {
  it("keeps the recipe's bytes and the push's in separate files", () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-sink-"));
    dirs.push(dir);
    const sink = createNodeLogSink(dir, "abc1234");
    const id = "build@x86_64-linux";

    sink.append(id, "compiling\n");
    sink.append(id, "[odu] pushing 2 result paths\n", "push");

    expect(readFileSync(join(dir, logPathFor("abc1234", id)), "utf-8")).toBe(
      "compiling\n",
    );
    expect(
      readFileSync(join(dir, logPathFor("abc1234", id, "push")), "utf-8"),
    ).toBe("[odu] pushing 2 result paths\n");
  });

  it("seals one stream without sealing the other", () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-sink-"));
    dirs.push(dir);
    const sink = createNodeLogSink(dir, "abc1234");
    const id = "build@x86_64-linux";

    sink.end(id);
    expect(sink.isEnded(id)).toBe(true);
    expect(sink.isEnded(id, "push")).toBe(false);

    appendIfOpen(sink, { nodeId: id, stream: "recipe" }, "too late\n");
    appendIfOpen(sink, { nodeId: id, stream: "push" }, "[odu] 4 paths sent\n");
    expect(
      readFileSync(join(dir, logPathFor("abc1234", id, "push")), "utf-8"),
    ).toBe("[odu] 4 paths sent\n");
    expect(() => sink.append(id, "direct\n")).toThrow(/after its log ended/);
  });
});
