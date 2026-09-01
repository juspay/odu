/**
 * The `checkout` root rule, pinned at the ONE schema all nine bespoke tools
 * share (`checkoutField`). Handler-level tests (./checkoutTargeting.test.ts)
 * call handlers directly and so bypass decode; the root rule lives at decode —
 * the refusal a host sees as a tool error BEFORE any verb touches the path.
 *
 * `runInput` stands in for all nine structs: each embeds the same exported
 * `checkoutField` value, so validating one validates the shared field itself
 * (server.test.ts pins that all nine advertise it).
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Result, Schema } from "effect";
import { runInput } from "./runTool";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "odu-mcp-field-"));
  dirs.push(d);
  return d;
}

function decodes(input: unknown): boolean {
  return Result.isSuccess(Schema.decodeUnknownResult(runInput)(input));
}

describe("checkoutField — the root rule, enforced at decode", () => {
  it("rejects a relative path", () => {
    expect(decodes({ checkout: "some/relative/dir" })).toBe(false);
  });

  it("rejects an absolute path that does not exist", () => {
    expect(decodes({ checkout: join(dir(), "never-created") })).toBe(false);
  });

  it("rejects an existing directory that is not a checkout root (no .git)", () => {
    expect(decodes({ checkout: dir() })).toBe(false);
  });

  it("accepts a root whose .git is a DIRECTORY", () => {
    const d = dir();
    mkdirSync(join(d, ".git"));
    expect(decodes({ checkout: d })).toBe(true);
  });

  it("accepts a worktree root whose .git is a FILE", () => {
    const d = dir();
    writeFileSync(join(d, ".git"), "gitdir: /elsewhere/main/.git/worktrees/x\n");
    expect(decodes({ checkout: d })).toBe(true);
  });

  it("leaves an omitted checkout untouched (the cwd default is not validated here)", () => {
    expect(decodes({})).toBe(true);
    expect(decodes({ selectors: ["ci"] })).toBe(true);
  });
});
