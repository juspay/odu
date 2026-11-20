import { describe, expect, it } from "bun:test";
import type { Logger } from "effect";
import { foregroundLogger } from "./web";

describe("foreground odu web logging", () => {
  it("prints cache row info and drops the host's own narration", () => {
    const lines: string[] = [];
    const sink = {
      debug: () => {},
      info: (_fields: unknown, message: string) => void lines.push(message),
      warn: () => {},
      error: () => {},
    } as unknown as Parameters<typeof foregroundLogger>[0];
    const log = foregroundLogger(sink);
    log.info({}, "odu cache: cache.nar.served");
    log.info({}, "odu cache: cache.migration.complete");
    log.info({}, "listener bound");
    expect(lines).toEqual([
      "odu cache: cache.nar.served",
      "odu cache: cache.migration.complete",
    ]);
  });
});
