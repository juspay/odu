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
 * **AND THE WALK LEAVES THIS PACKAGE.** `main.ts` imports `@odu/cache/cli` and
 * `@odu/launch/webLauncher`, and a wall that stopped at this package's
 * directories would not police either — it would have declared the spawn
 * machinery unreachable while `main.ts` reached it through one hop. So a
 * specifier is resolved through the MEMBER's own `exports` map, wherever the
 * member is, and every file the walk reaches is policed by the same table. The
 * one allowance is named below, per file and per specifier.
 *
 * ## The one client of another authority
 *
 * `odu cache push` is a client of the cache's HTTP API rather than of the
 * service, and it is admissible here for a reason this wall can check: it
 * imports none of the three authorities above, and it has to be this way
 * because the paths live on the machine that built them — a push cannot go
 * THROUGH the service, which is not where the bytes are. `cacheCmd.ts` is
 * therefore policed like every other public client, and passes on the same
 * terms.
 *
 * The walk is a PARSE rather than a line scan, and TYPE-ONLY EDGES COUNT: a
 * `import type { RunLauncher }` is how a port gets threaded back in one
 * refactor later, and the compiler would not object.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
/** Every workspace member, by the name its manifest gives it. */
const MEMBERS: ReadonlyMap<string, string> = (() => {
  const found = new Map<string, string>();
  const root = join(packageRoot, "..", "..");
  for (const entry of readdirSync(join(root, "packages"))) {
    const dir = join(root, "packages", entry);
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
        name?: string;
      };
      if (manifest.name !== undefined) found.set(manifest.name, `packages/${entry}`);
    } catch {
      // Not a member (a stray directory). Nothing to police.
    }
  }
  return found;
})();

/** This package's own name, for the `@odu/cli/x` spelling. */
const SELF = "packages/cli";
const REPO = join(packageRoot, "..", "..");

/**
 * Every `@odu/*` specifier `src/main.ts` names — DERIVED, not listed.
 *
 * This used to derive only `@odu/cli/*`, which was true while every face was in
 * this package. It is not any more: `odu cache` is `@odu/cache/cli`'s and the
 * bootstrap is `@odu/launch`'s, so a wall that walked only `@odu/cli/` would
 * have called the spawn machinery unreachable while `main.ts` reached it.
 */
const mainImports = specifiersIn(
  readFileSync(join(REPO, "src", "main.ts"), "utf-8"),
  "src/main.ts",
);

/** The modules of THIS package `main.ts` reaches — what the totality assertion
 *  below classifies. */
const reachedFromMain = mainImports
  .filter((s) => s.startsWith("@odu/cli/"))
  .map((s) => `${s.slice("@odu/cli/".length)}.ts`)
  .sort();

/**
 * A MEMBER'S `exports` MAP, honoured rather than guessed: a specifier resolves
 * to the file the manifest promises, so a door this package does not open is
 * external (and a door a member stops opening is a missing file, not a silent
 * pass).
 */
function exportedFile(member: string, sub: string): string | null {
  const dir = MEMBERS.get(member);
  if (dir === undefined) return null;
  let manifest: { exports?: Record<string, unknown>; main?: string };
  try {
    manifest = JSON.parse(readFileSync(join(REPO, dir, "package.json"), "utf-8"));
  } catch {
    return null;
  }
  const exports = manifest.exports ?? {};
  const key = sub === "" ? "." : `./${sub}`;
  const literal = exports[key] ?? exports["./*"];
  if (typeof literal !== "string") return null;
  // EVERY `*`, because that is what an npm `exports` wildcard means: all
  // instances on the right-hand side are replaced. (`String.prototype.replace`
  // with a string pattern replaces the first only, which a scanner flags and a
  // two-star pattern would honour half of.)
  return join(dir, sub === "" ? literal : literal.replace(/\*/g, sub));
}

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
  // `run-coordinator` and `lease-hold`: argv entry points a launcher types,
  // never a person. `run-coordinator` IS the coordinator. See `./internalCli`
  // on why these moved out of `main.ts` — it was so that this derivation could
  // start at a root that is itself clean.
  "internalCli.ts",
];

/**
 * WHICH FILES THE FORBIDDEN TABLE APPLIES TO — the FACES, and not the engine
 * they call.
 *
 * The walk follows a client into the packages it legitimately names (the
 * bootstrap in `@odu/launch`, the cache's own CLI), so a table applied to every
 * file it reaches would police the ENGINE's own imports: `coordinator/spawn.ts`
 * reads the catalog and the checkout dial because it is the thing that starts a
 * coordinator, and `service-client/socket.ts` dials a socket because that is
 * what a local client dial is. Those are the authority, not a client holding it.
 *
 * So the table applies to a specifier written in a FACE — this package, the
 * cache's CLI, the bootstrap — and to `main.ts` itself. Everything the walk
 * reaches from there is fair game.
 */
const FACE_PACKAGES = ["packages/cli", "packages/cache", "packages/launch"] as const;

const isFaceFile = (file: string): boolean =>
  file === "src/main.ts" || FACE_PACKAGES.some((one) => file.startsWith(`${one}/`));

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
 * THE ONE ALLOWANCE, named per-file AND per-specifier, and it is now a file the
 * walk REACHES rather than one beside it.
 *
 * A daemon launcher has to know odu's own re-invocation argv and the environment
 * a child needs, and both live with the spawn machinery in
 * `@odu/execution/coordinator/spawn`. That module starts nothing by itself — it
 * is the pure description of HOW something would be started — and what
 * `webDaemonLaunch` starts is the SERVICE, not a run. Allowing the whole
 * `coordinator` prefix would allow the launcher and the retry policy with it.
 *
 * **`main.ts` reaches it**: `odu` bootstraps the singleton through
 * `@odu/launch/webLauncher`, which imports `@odu/launch/webDaemonLaunch`, which
 * imports the spawn description. Until this round the wall walked only
 * `@odu/cli/`, so it called that path unreachable and was wrong.
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "packages/launch/src/webDaemonLaunch.ts": ["@odu/execution/coordinator/spawn"],
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
  const queue = entries.map((file) => `${SELF}/src/${file}`);
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    const specifiers = specifiersIn(readFileSync(join(REPO, file), "utf-8"), file);
    seen.set(file, specifiers);
    for (const spec of specifiers) {
      const local = localFile(spec, file);
      if (local !== null) queue.push(local);
    }
  }
  return seen;
}

/**
 * The file inside THIS package a specifier names, or `null` for anything else.
 *
 * Two spellings reach the same file and BOTH have to be followed.
 * `./leaseCmd` is the obvious one. `@odu/cli/leaseCmd` is the one that matters:
 * `packages/cli/package.json` declares `"exports": { "./*": "./src/*.ts" }` and
 * `node_modules/@odu/cli` is a symlink back to this package, so a module here
 * can import its own sibling by the package name — and that is the idiomatic
 * form in this tree, not an exotic dodge. `src/main.ts` uses it for every one
 * of its imports.
 *
 * Following only `.` left a one-hop hole big enough for everything the wall
 * exists to stop: an `import { … } from "@odu/cli/leaseCmd"` in a public client
 * was neither followed (not dot-prefixed) nor forbidden (`@odu/cli` is not an
 * authority), so that module and its whole import closure — the engine, the
 * lease machinery, `runCommand` — dropped silently out of the walk. It was
 * demonstrated against this tree: the wall stayed green.
 */
function localFile(specifier: string, from = "src/main.ts"): string | null {
  if (specifier.startsWith(".")) {
    const base = normalize(join(dirname(from), specifier));
    return firstOf([`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]);
  }
  const match = /^(@odu\/[a-z-]+)(?:\/(.*))?$/.exec(specifier);
  if (match === null) return null;
  const member = match[1] as string;
  const file = exportedFile(member, match[2] ?? "");
  if (file === null) return null;
  const normalized = normalize(file);
  // `./*` maps a subpath onto a file; a manifest whose wildcard lands on a
  // directory is not a spelling this tree uses.
  return firstOf([normalized, `${normalized}.ts`, `${normalized}.tsx`]);
}

/** POSIX-normalise and strip the leading `./`, so a key reads as a repo path. */
function normalize(file: string): string {
  const parts: string[] = [];
  for (const part of file.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/** The first of these that exists, or `null`. */
function firstOf(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    try {
      readFileSync(join(REPO, candidate), "utf-8");
      return candidate;
    } catch {
      // Try the next spelling.
    }
  }
  return null;
}

describe("the authority wall", () => {
  const closure = closureOf(PUBLIC_CLIENTS);
  // THE ROOT IS POLICED TOO. `src/main.ts` seeds the derivation, so it was
  // never a member of the closure and its own imports were never checked —
  // and it is the single likeliest site for the regression this file exists
  // against, because every public verb's `case` body is in it. A `case "run":`
  // that called `runCommand(...)` when `connectOrStart` threw would have been
  // exactly the "fell back to doing the work itself" fallback the header
  // describes, and the wall would have stayed green. It is spelled under a
  // pseudo-name because it lives outside `srcRoot` and is not a module of this
  // package.
  const policed = new Map(closure).set("src/main.ts", mainImports);

  it("has public clients to police", () => {
    // A wall that policed nothing would pass forever. Both halves are asserted:
    // the entry points resolved, and the closure genuinely grew past them.
    expect(closure.size).toBeGreaterThanOrEqual(PUBLIC_CLIENTS.length);
    expect([...closure.keys()]).toContain("packages/cli/src/serviceCommands.ts");
    // And the derivation actually found the tree, rather than reading a
    // `main.ts` that had moved and quietly policing nothing.
    expect(reachedFromMain.length).toBeGreaterThan(5);
  });

  it("keeps the exempt set exactly this one, and no more", () => {
    // THE PRESSURE IS ON THE EXEMPTIONS, and it took a review to see that.
    //
    // This assertion used to compare `[...PUBLIC_CLIENTS, ...SERVICE_ROOTS]`
    // against `reachedFromMain` and call itself "the assertion that makes
    // forgetting impossible". `PUBLIC_CLIENTS` is DEFINED as
    // `reachedFromMain \ SERVICE_ROOTS`, so it was comparing (A \ S) ∪ (S ∩ A)
    // to A — equal for every possible input, and incapable of failing.
    //
    // A new import into `main.ts` was never the danger: it lands in
    // `PUBLIC_CLIENTS` by default and gets walled. The danger is the other
    // direction — adding a name to `SERVICE_ROOTS` silently removes that module
    // AND its whole transitive closure from the walk, which is the one edit
    // that can quietly un-police the engine. So the exempt set is pinned to a
    // literal here: growing it is a diff a reviewer sees and has to agree with.
    expect(
      [...SERVICE_ROOTS].sort(),
      "SERVICE_ROOTS changed. Every name here is a module the wall STOPS " +
        "walking, so adding one removes it and everything it imports from the " +
        "policed set. That is occasionally right — `internalCli.ts` really is " +
        "the coordinator and its holder — and it is never something to do in " +
        "passing. The daemon root used to be the other one; it left this " +
        "package for `@odu/host`, together with the spawn allowance that stood " +
        "beside it, so neither is this file's to name any more.",
    ).toEqual(["internalCli.ts"]);
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
    for (const [file, specifiers] of policed) {
      if (!isFaceFile(file)) continue;
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

  it("allows one specifier, in one file, and nothing else", () => {
    // The spawn allowance lived here, per-file AND per-specifier, and it is
    // gone with the file it was about: `webDaemonLaunch.ts` is `@odu/host`'s
    // now, and `@odu/execution/coordinator` is not reachable from anything
    // `src/main.ts` imports. An EMPTY map is the honest answer, and pinning it
    // empty is what stops a future "just this one" from being added in passing:
    // every public client here reaches the engine through the service, and none
    // of them by naming a coordinator module.
    expect(
      ALLOWED,
      "an allowance was added into the public CLI. The daemon's spawn machinery " +
        "lives in @odu/launch; a client that needs a coordinator module is a " +
        "client holding authority the service owns.",
    ).toEqual({ "packages/launch/src/webDaemonLaunch.ts": ["@odu/execution/coordinator/spawn"] });
  });
});
