/**
 * THE AUTHORITY WALL, ENFORCED — what a public client may not import.
 *
 * odu has one authority now: the shared service daemon. Every public command,
 * `odu surface`, and the `odu mcp` bridge are CLIENTS of it, and the value of
 * that arrangement is not that the code was moved — it is that a face cannot
 * quietly grow the authority back. Prose cannot promise that. This can.
 *
 * The failure mode this exists against is specific and it has happened before,
 * in this repository, in exactly this shape: a command that could not reach the
 * service "helpfully" fell back to doing the work itself. That fallback is
 * invisible in the common case and appears only when the shared service is
 * unreachable — which is precisely the moment two answers about one run start
 * to diverge, and the moment nobody is watching closely.
 *
 * ## The three authorities
 *
 * A module is a public client if a public command reaches it. Such a module may
 * not import:
 *
 *   - **execution** — `@odu/execution`'s coordinator: `runCommand`, the
 *     launcher, the retry policy. Starting or retrying a run is the service's,
 *     and a client that could spawn a coordinator is a second scheduler.
 *   - **the catalog's writes** — `@odu/run-history`'s store, import and
 *     retention. The catalog is the service's record of what happened; a second
 *     writer is a second history.
 *   - **the checkout dial** — `@odu/run-client/dial`. `.ci/odu.sock` is how the
 *     DAEMON reaches a coordinator, after proving which run is on the other end.
 *     A face that dialled it directly would be mutating a run it had not
 *     identified.
 *
 * ## Nothing is deliberately walled out any more
 *
 * This file used to name three exceptions. `odu dump` and `odu graph` "read a
 * justfile and touch no run"; `odu protect` "spends the CALLER's gh credential,
 * which the daemon has no way to borrow". Both defences were wrong.
 *
 * Reading a justfile is not the absence of authority, it is a SECOND RESOLVER:
 * what odu will run for a checkout is a question `run.start` answers through
 * the same engine, so a face answering it locally could disagree with the run
 * it was meant to predict, and nothing would notice. And the `protect` defence
 * described an odu that does not exist — the coordinator the daemon launches
 * has posted commit statuses with that same credential all along.
 *
 * Every public capability is a member on the shared surface now. The set this
 * walks is DERIVED from `src/main.ts`'s own imports, so a command cannot be
 * exempted by forgetting to list it.
 *
 * The walk is a PARSE rather than a line scan, and TYPE-ONLY EDGES COUNT: a
 * `import type { RunLauncher }` is how a port gets threaded back in one
 * refactor later, and the compiler would not object.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const packageRoot = join(import.meta.dirname, "..");
const srcRoot = join(packageRoot, "src");

/**
 * Every `@odu/cli/*` module `src/main.ts` imports — DERIVED, not listed.
 *
 * This used to be a literal array, on the reasoning that deriving the entry set
 * would "grow the allowlist automatically". That reasoning had it exactly
 * backwards, and the review that caught it was right: what a literal list grows
 * automatically is the set of modules the wall does not look at. A command
 * added to `main.ts` and forgotten here was simply not policed, and the suite
 * went on passing — which is how nine commands came to hold local authority
 * under a green test whose name says they do not.
 *
 * Deriving the ENTRY set makes the wall stricter. Deriving the FORBIDDEN set
 * would make it useless; that stays literal below, and the difference between
 * the two is the whole design.
 */
const mainImports = specifiersIn(
  readFileSync(join(packageRoot, "..", "..", "src", "main.ts"), "utf-8"),
  "main.ts",
);

/** `@odu/cli/foo` → `foo.ts`, which is how a specifier becomes a file in this
 *  package. Anything else `main.ts` imports is not ours to walk. */
const reachedFromMain = mainImports
  .filter((s) => s.startsWith("@odu/cli/"))
  .map((s) => `${s.slice("@odu/cli/".length)}.ts`)
  .sort();

/**
 * The two modules `main.ts` reaches that are NOT clients — with the reason each
 * is the thing a client talks to rather than a client.
 *
 * They are named here so that classifying a module is a decision somebody makes
 * on purpose, and the totality assertion below is what forces the decision:
 * a new `@odu/cli/*` import into `main.ts` belongs to one list or the other, and
 * belonging to neither is a failure rather than a silent exemption.
 */
const SERVICE_ROOTS: readonly string[] = [
  // The daemon itself: it binds the listener, builds the service and BINDS THE
  // PORTS. Reaching the engine is its entire job — `odu web` is how the
  // authority comes into existence, not a face onto it.
  "web.ts",
  // `run-coordinator` and `lease-hold`: argv entry points a launcher types,
  // never a person. `run-coordinator` IS the coordinator. See `./internalCli`
  // on why these moved out of `main.ts` — it was so that this derivation could
  // start at a root that is itself clean.
  "internalCli.ts",
];

/** What the wall polices: everything `main.ts` reaches that is not the service
 *  itself. */
const PUBLIC_CLIENTS = reachedFromMain.filter(
  (f) => !SERVICE_ROOTS.includes(f),
);

/** Import specifiers a public client may not reach, with the authority each
 *  one is. Prefix-matched, so a submodule cannot slip past the parent. */
const FORBIDDEN: readonly { prefix: string; authority: string }[] = [
  { prefix: "@odu/execution/coordinator", authority: "execution" },
  { prefix: "@odu/execution/just", authority: "pipeline ingest" },
  { prefix: "@odu/run-history/store", authority: "the catalog" },
  { prefix: "@odu/run-history/import", authority: "the catalog" },
  { prefix: "@odu/run-history/retention", authority: "the catalog" },
  { prefix: "@odu/run-history/query", authority: "the catalog" },
  { prefix: "@odu/run-client/dial", authority: "the checkout dial" },
  { prefix: "@odu/service/", authority: "the service's own internals" },
];

/**
 * The ONE exception, named with its reason.
 *
 * A daemon launcher has to know odu's own re-invocation argv and which
 * environment a child needs, and both live with the spawn machinery in
 * `@odu/execution/coordinator/spawn`. That module starts nothing by itself —
 * it is the pure description of HOW something would be started — and the thing
 * `webDaemonLaunch` starts is the service, not a run. Allowing the whole
 * `coordinator` prefix for this one file would allow the launcher and the retry
 * policy with it, so the exception is per-file AND per-specifier.
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "webDaemonLaunch.ts": ["@odu/execution/coordinator/spawn"],
};

/** Every module specifier a consumer's compiler would have to resolve: static
 *  imports and re-exports (`import type` included), `import x = require("…")`,
 *  dynamic `import()`, and `import("…").T` in type position. */
function specifiersIn(source: string, fileName: string): string[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const literal = (node: ts.Node | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node)) out.push(node.text);
  };
  const walk = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      literal(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      literal(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) literal(node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      literal(node.arguments[0]);
    }
    ts.forEachChild(node, walk);
  };
  walk(parsed);
  return out;
}

/** Follow a public client's LOCAL imports too. A face that imported the engine
 *  through one hop of its own would satisfy a direct-edge check and hold the
 *  authority anyway, which is the whole trick this has to survive. */
function closureOf(entries: readonly string[]): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    const specifiers = specifiersIn(
      readFileSync(join(srcRoot, file), "utf-8"),
      file,
    );
    seen.set(file, specifiers);
    for (const spec of specifiers) {
      if (!spec.startsWith(".")) continue;
      const local = `${spec.replace(/^\.\//, "")}.ts`;
      queue.push(local);
    }
  }
  return seen;
}

describe("the authority wall", () => {
  const closure = closureOf(PUBLIC_CLIENTS);

  it("has public clients to police", () => {
    // A wall that policed nothing would pass forever. Both halves are asserted:
    // the entry points resolved, and the closure genuinely grew past them.
    expect(closure.size).toBeGreaterThanOrEqual(PUBLIC_CLIENTS.length);
    expect([...closure.keys()]).toContain("serviceCommands.ts");
    // And the derivation actually found the tree, rather than reading a
    // `main.ts` that had moved and quietly policing nothing.
    expect(reachedFromMain.length).toBeGreaterThan(5);
  });

  it("classifies every module main.ts reaches, on purpose", () => {
    // THE ASSERTION THAT MAKES FORGETTING IMPOSSIBLE. Every `@odu/cli/*` import
    // in `main.ts` is either a public client (walled) or a named service root
    // (exempt, with its reason above). A new one is neither until somebody
    // decides, and until then this fails — which is the opposite of the old
    // literal list, where a new one was silently unpoliced.
    expect(
      [...PUBLIC_CLIENTS, ...SERVICE_ROOTS.filter((r) => reachedFromMain.includes(r))].sort(),
      "src/main.ts imports an @odu/cli module this test has not classified. " +
        "Add it to SERVICE_ROOTS with the reason it is the service rather than " +
        "a face onto it — or leave it out, and it will be walled as a client.",
    ).toEqual(reachedFromMain);
  });

  it("names no service root that main.ts has stopped importing", () => {
    // A dead exemption is worse than none: it reads as a live decision and
    // policing has silently moved on without it.
    for (const root of SERVICE_ROOTS) {
      expect(
        reachedFromMain,
        `SERVICE_ROOTS names ${root}, which src/main.ts no longer imports — ` +
          "remove the exemption or restore the import.",
      ).toContain(root);
    }
  });

  it("walls every command the usage text advertises", () => {
    // The inventory, from the other side. `main.ts` is the only place a public
    // verb exists, so a verb whose dispatch does not reach a walled client is a
    // verb doing its own work — which is exactly the shape the review found
    // nine times over.
    for (const face of [
      "serviceCommands.ts",
      "serviceStatus.ts",
      "serviceVenue.ts",
      "servicePipeline.ts",
      "serviceCli.ts",
      "serviceMcp.ts",
    ]) {
      expect(
        PUBLIC_CLIENTS,
        `${face} is a public face and must be reachable from src/main.ts`,
      ).toContain(face);
    }
  });

  it("lets no public client reach execution, the catalog, or a checkout dial", () => {
    const offenders: string[] = [];
    for (const [file, specifiers] of closure) {
      for (const spec of specifiers) {
        const forbidden = FORBIDDEN.find((f) => spec.startsWith(f.prefix));
        if (forbidden === undefined) continue;
        if ((ALLOWED[file] ?? []).includes(spec)) continue;
        offenders.push(`${file} imports ${spec} (${forbidden.authority})`);
      }
    }
    expect(
      offenders,
      `${offenders.join("\n")}\n\nA public client has taken back authority ` +
        "that belongs to the shared service. Every public command is a client " +
        "of the daemon; it may render an answer and choose an exit code, and " +
        "it may not start a run, write the catalog, or dial a checkout's " +
        "socket. If a client genuinely needs something the service does not " +
        "expose, the fix is a member on the service surface — never a second " +
        "path to the engine, and never a fallback for when the daemon is " +
        "unreachable.",
    ).toEqual([]);
  });

  it("keeps the one allowance per-file AND per-specifier", () => {
    // The daemon launcher may name odu's own re-invocation argv. It may not
    // reach the run launcher standing beside it in the same directory.
    const launcher = closure.get("webDaemonLaunch.ts") ?? [];
    expect(launcher).toContain("@odu/execution/coordinator/spawn");
    expect(launcher).not.toContain("@odu/execution/coordinator/launcher");
    expect(launcher).not.toContain("@odu/execution/coordinator/recovery");
  });

  it("does not let the allowance travel to another file", () => {
    for (const [file, specifiers] of closure) {
      if (file === "webDaemonLaunch.ts") continue;
      expect(
        specifiers.filter((s) => s.startsWith("@odu/execution/coordinator")),
        `${file} reaches the coordinator. Only webDaemonLaunch.ts may, and ` +
          "only for the spawn description it needs to start the SERVICE.",
      ).toEqual([]);
    }
  });
});
