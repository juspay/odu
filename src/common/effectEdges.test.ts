/**
 * The `Effect.run*` allowlist — the depth bound, enforced by construction.
 *
 * odu's adoption depth is the same one kolu locked: services and the RPC/
 * surface tier are Effect-native, and the leaves (rendering, the just→DAG
 * transform, path/duration helpers, the process edge) stay plain. What keeps
 * that from rotting is not review — it is this test.
 *
 * A lint rule cannot see it. Biome's Promise rules are blind to an Effect that
 * was never run, and an `Effect.runPromise` sprinkled into a leaf typechecks
 * perfectly while quietly making that leaf an Effect boundary. So the sanctioned
 * call sites are ENUMERATED, and a new one is a failing test with a message
 * telling the author what decision they are actually making.
 *
 * kolu carries the identical test for the identical reason (its PLAN #25 / W6).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

/** Every file under `src/` that may run an Effect at a boundary, with the
 *  reason it is allowed to. Keep this list SHORT — each entry is a place where
 *  Effect's world ends and a Promise/callback world begins, and a migration
 *  that grows this list has stopped drawing a boundary. */
const SANCTIONED = new Map<string, string>([
  [
    "common/effectEdge.ts",
    "odu's ONE edge between Effect's world and the Promise world the " +
      "coordinator and CLI are written in. `runUnary` dispatches a unary member " +
      "call; `firstFrame` runs a stream's head; `subscribe` hands back an async " +
      "iterator. All three exist so no consumer re-derives the laziness, " +
      "teardown and dispatch rules — nor invents a second boundary.",
  ],
]);

const RUN_CALL = /\bEffect\.run(?:Promise|Sync|Fork|PromiseExit|SyncExit)\b/;

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...tsFilesUnder(path));
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(path);
  }
  return out;
}

describe("Effect.run* edge discipline", () => {
  const srcRoot = join(import.meta.dirname, "..");

  it("runs effects only at the sanctioned boundaries", () => {
    const offenders: string[] = [];
    for (const path of tsFilesUnder(srcRoot)) {
      const rel = path.slice(srcRoot.length + 1);
      // Test files are their own edge: a test IS a Promise-shaped harness, and
      // pinning where a suite runs an effect would pin the suite's mechanism
      // rather than the source's boundary.
      if (rel.endsWith(".test.ts") || rel.endsWith(".test-d.ts")) continue;
      if (!RUN_CALL.test(readFileSync(path, "utf-8"))) continue;
      if (SANCTIONED.has(rel)) continue;
      offenders.push(rel);
    }
    expect(
      offenders,
      `${offenders.join(", ")} runs an Effect outside the sanctioned edges. ` +
        "That makes the file an Effect boundary. If it should be one, add it " +
        "to SANCTIONED with the reason; if it should not, hand the Effect to a " +
        "caller that already is one (a surface handler returns an Effect; a " +
        "Stream consumer goes through common/stream.ts).",
    ).toEqual([]);
  });

  it("never `await`s or `void`s a member-face call — it compiles and never dispatches", () => {
    // THE governance-grade hazard of the Effect face, and the reason this test
    // is not merely stylistic.
    //
    // `client.surface.node.rerun({ id })` returns an `Effect` — a description
    // of the call. An Effect is not a thenable, so `await` on one resolves to
    // the Effect OBJECT and dispatches nothing, and `void` on one discards it
    // just as silently. Both compile. Both read exactly like the line that was
    // correct before the face flipped. `tsc` cannot see it wherever the result
    // is discarded or loosely typed, and review does not catch it either —
    // kolu hit this five times in a single wave, once disabling the very drain
    // a daemon acceptance test existed to prove.
    //
    // odu shipped one too: `introspect.ts`'s attach dashboard spelled
    // `rerun: (id) => void client.surface.node.rerun({ id })`, so pressing `r`
    // in an attached session silently did nothing.
    //
    // The pattern is deliberately NARROW — `await`/`void` applied DIRECTLY to a
    // face call, with nothing between but a reference path. So the one
    // legitimate spelling, `await runUnary(client.surface.ns.verb(x))`, does
    // not match. That restraint is the design: a check that condemned the
    // sanctioned form would be switched off within a week, and then the real
    // ones ride back in.
    const BAD = /\b(?:await|void)\s+[A-Za-z_$][\w$.]*\.surface\.[\w$]+\.[\w$]+\s*\(/;
    // Comment lines are skipped, and that is not a loophole — it is the point.
    // The banned shape has to be SPELLABLE in prose so a doc comment can teach
    // it as the wrong answer (this file does, and so does `effectEdge.ts`'s
    // header). A check that condemned its own explanation would force the
    // explanation out, which is how the knowledge gets lost.
    const isComment = (line: string): boolean =>
      /^\s*(?:\/\/|\/\*|\*)/.test(line);
    const offenders: string[] = [];
    for (const path of tsFilesUnder(srcRoot)) {
      const rel = path.slice(srcRoot.length + 1);
      const lines = readFileSync(path, "utf-8").split("\n");
      lines.forEach((line, i) => {
        if (!isComment(line) && BAD.test(line)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      `${offenders.join("\n")}\n\nA member-face call is an Effect. ` +
        "`await` and `void` on one compile and dispatch NOTHING. Run it: " +
        "`await runUnary(<call>)` from a Promise-shaped caller, or compose it " +
        "(`yield*` / Effect.* ) from an Effect-shaped one.",
    ).toEqual([]);
  });

  it("every sanctioned entry still runs an Effect (no dead allowances)", () => {
    // The other direction, and the one that rots silently: an entry left behind
    // after its call site moved reads as a boundary that no longer exists, and
    // would quietly re-admit one later.
    const stale: string[] = [];
    for (const rel of SANCTIONED.keys()) {
      if (!RUN_CALL.test(readFileSync(join(srcRoot, rel), "utf-8"))) {
        stale.push(rel);
      }
    }
    expect(stale).toEqual([]);
  });
});
