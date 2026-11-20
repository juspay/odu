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
    for (const relative of [".", "..", "repo", "./repo", "a/b"]) {
      const refusal = notAbsolute("protect.apply", relative);
      expect(refusal, `"${relative}" was allowed through`).not.toBeNull();
      expect(refusal?.code).toBe("checkout_refused");
      expect(refusal?.message).toContain("protect.apply");
      expect(refusal?.message).toContain(relative);
    }
  });

  it("says why, not just no", () => {
    const refusal = notAbsolute("venue.hold", "./somewhere");
    expect(refusal?.message).toContain("ABSOLUTE");
    expect(refusal?.message).toContain("working directory");
  });
});

function checkoutHandlers(source: string): Map<string, boolean> {
  const parsed = ts.createSourceFile(
    "service.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const found = new Map<string, boolean>();

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
    expect([...handlers.keys()].sort()).toEqual([
      "pipeline.read",
      "protect.apply",
      "run.list",
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
    for (const file of ["start.ts", "catalog.ts"]) {
      const text = readFileSync(join(import.meta.dirname, file), "utf-8");
      expect(text, `${file} lost its absolute-path guard`).toContain(
        "isAbsolute(input.checkout)",
      );
    }
  });
});
