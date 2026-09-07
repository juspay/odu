/**
 * A RELATIVE CHECKOUT IS THE DAEMON'S DIRECTORY, NOT YOURS — enforced.
 *
 * Every verb whose subject is a directory takes it as an ABSOLUTE path. That
 * has been the rule since `run.start`, and its reason is written on the field:
 * an MCP host's cwd is not a fact about what the user meant. What did not exist
 * until now was anything that made it a rule rather than a habit — and four
 * verbs were added without it.
 *
 * ## Why this is worth a test of its own
 *
 * The failure is silent and it is not small. An agent whose own working
 * directory is somebody's home sends `protect_apply {checkout: "."}`. The
 * daemon was started by `odu web --background` from a checkout, so its cwd IS a
 * repository; `git rev-parse --show-toplevel` answers happily, and required
 * status checks are written onto THAT repository's default branch. Nothing in
 * the request named it, nothing in the answer mentions it, and the person who
 * finds out is whoever's next pull request will not merge.
 *
 * `venue.hold` is the same shape, quieter: the lease record lands under the
 * daemon's checkout, where the coordinator that later reads the real one's will
 * never see it. `pipeline.read` answers with the wrong repository's DAG.
 *
 * The terminal faces were never exposed — they send `checkoutHere()`, which is
 * absolute by construction — so this reachable only through the browser and the
 * agent. That asymmetry is precisely what the consolidation exists to remove,
 * which makes it worse than an ordinary bug rather than better.
 *
 * ## Two halves, and the second is the one that lasts
 *
 * The first half tests the guard. The second reads `./service.ts` and asserts
 * that EVERY handler taking a `checkout` calls it — because the guard being
 * correct is not the property that was violated. The property that was violated
 * is "somebody remembered to call it", and only a check over the dispatch can
 * hold that for a verb nobody has written yet.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";
import { notAbsolute } from "./service";

describe("the absolute-checkout guard", () => {
  it("passes an absolute path through", () => {
    expect(notAbsolute("pipeline.read", "/home/someone/repo")).toBeNull();
  });

  it("refuses the paths that resolve against the daemon", () => {
    // `.` is the one an agent actually sends, and it is the most dangerous
    // precisely because it is the most innocent-looking.
    for (const relative of [".", "..", "repo", "./repo", "a/b"]) {
      const refusal = notAbsolute("protect.apply", relative);
      expect(refusal, `"${relative}" was allowed through`).not.toBeNull();
      expect(refusal?.code).toBe("checkout_refused");
      // The verb is NAMED, because a caller with four checkout-taking verbs in
      // flight needs to know which one it got wrong.
      expect(refusal?.message).toContain("protect.apply");
      expect(refusal?.message).toContain(relative);
    }
  });

  it("says why, not just no", () => {
    const refusal = notAbsolute("venue.hold", "./somewhere");
    // A refusal a caller cannot act on is a refusal they will work around.
    expect(refusal?.message).toContain("ABSOLUTE");
    expect(refusal?.message).toContain("working directory");
  });
});

/**
 * Every procedure handler in `./service.ts` that reads `input.checkout`, and
 * whether it also mentions the guard.
 *
 * A PARSE rather than a grep: the handlers are nested arrow functions inside a
 * deeply nested object literal, several of them wrap the call in
 * `Effect.suspend`, and a line-oriented check would have to reproduce all of
 * that — and would report "no handlers found", a PASS, the first time the shape
 * changed.
 */
function checkoutHandlers(source: string): Map<string, boolean> {
  const parsed = ts.createSourceFile(
    "service.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const found = new Map<string, boolean>();

  /** `pipeline: { read: … }` → `pipeline`, given the `read` assignment. Starts
   *  ABOVE the node's own property so a verb is not reported as its own
   *  namespace. */
  const namespaceOf = (assignment: ts.Node): string => {
    let at: ts.Node | undefined = assignment.parent;
    while (at !== undefined) {
      if (ts.isPropertyAssignment(at) && ts.isIdentifier(at.name)) {
        return at.name.text;
      }
      at = at.parent;
    }
    return "?";
  };

  const visit = (node: ts.Node): void => {
    // A HANDLER, not merely a property mentioning the word. `checkout:
    // input.checkout` appears inside every port-call object literal too, and a
    // check that counted those would report four phantom verbs and pass or fail
    // for reasons unrelated to the guard.
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer))
    ) {
      const body = node.initializer.getText(parsed);
      if (/\binput\.checkout\b/.test(body)) {
        found.set(
          `${namespaceOf(node)}.${node.name.text}`,
          /\bnotAbsolute\(/.test(body),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

describe("service.ts's checkout-taking handlers", () => {
  const source = readFileSync(join(import.meta.dirname, "service.ts"), "utf-8");
  const handlers = checkoutHandlers(source);

  it("found the handlers at all", () => {
    // A parse that matched nothing would make the assertion below vacuous —
    // which is the same failure mode one level up, and the one that lets a
    // "green" wall police nothing.
    expect([...handlers.keys()].sort()).toEqual([
      "pipeline.read",
      "protect.apply",
      "venue.hold",
      "venue.release",
    ]);
  });

  it("guards every one of them", () => {
    const unguarded = [...handlers].filter(([, guarded]) => !guarded).map(([v]) => v);
    expect(
      unguarded,
      `${unguarded.join(", ")} read input.checkout without calling ` +
        "notAbsolute(). A relative path resolves against the DAEMON's working " +
        "directory, so the verb would act on a repository the caller never " +
        "named — writing branch protection onto it, or leaving a lease record " +
        "where the coordinator will never find it.",
    ).toEqual([]);
  });
});

describe("the two handlers that guard it themselves", () => {
  it("run.start and catalog.import still refuse a relative checkout", () => {
    // They spell the guard inline rather than calling `notAbsolute`, because
    // both refuse through their own receipt-recording path — a refusal there
    // has to be WRITTEN DOWN so a repeat of the same request id replays it
    // rather than being told the outcome is unknown. Asserted here so the two
    // spellings cannot silently become one-and-a-half.
    for (const file of ["start.ts", "catalog.ts"]) {
      const text = readFileSync(join(import.meta.dirname, file), "utf-8");
      expect(text, `${file} lost its absolute-path guard`).toContain(
        "isAbsolute(input.checkout)",
      );
    }
  });
});
