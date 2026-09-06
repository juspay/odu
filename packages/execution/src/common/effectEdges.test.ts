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
 * **Scope: every `.ts` under `src/`, `tests/` and `packages/`** — the three
 * trees `tsconfig` compiles, harness code included. `packages/` is in scope
 * because an extracted package is still odu source: `@odu/run-client` hands a
 * consumer `Stream`s and `Effect`s to run at ITS own edge, and a run smuggled
 * into the package would be an Effect boundary odu ships to everyone. `*.test.ts` / `*.test-d.ts` is out of the
 * run-edge budget and out of that budget ONLY: a test file IS a process edge
 * (the runner calls it from a Promise, so it must run the effect it asserts
 * about), and enumerating those runs would budget the harness rather than the
 * product. The awaited-face ban below covers test files regardless, precisely
 * because a test that silently never dispatches is the bug that hides the
 * others.
 *
 * **The dodges these scans close.** Counting a NAMESPACED call is only honest
 * if the namespace cannot be dropped, and banning an awaited face only works if
 * the face cannot be renamed first. So beyond the two direct shapes:
 *
 *   - a bare named import (`import { runPromise } from "effect/Effect"`) and an
 *     UNCALLED run reference (`const run = Effect.runPromise`, `{ runFork } =
 *     Effect`, `.then(Effect.runPromise)`) each fail outright rather than being
 *     counted — aliasing a run function is itself bannable, which closes that
 *     dodge without needing dataflow;
 *   - a name bound to anything that STARTS as a member-face path is marked, so
 *     the alias (`const verb = client.surface.ns.verb; await verb(x)`), the
 *     stored description (`const p = client.surface.ns.verb(x); await p`) and
 *     the face handle (`const s = client.surface; await s.ns.verb(x)`) are all
 *     hits wherever they are awaited or voided in the same file.
 *
 * **Residual risk, stated so nobody mistakes this for a proof.** Face marking is
 * one hop and one file: `const a = c.surface.ns.verb; const b = a; await b(x)`
 * escapes, so does an alias exported and awaited in another module, and so does
 * a face handed to a helper that awaits its own parameter. A namespace import
 * under another name (`import * as E from "effect/Effect"; E.runPromise(x)`) is
 * not seen either. Each is an unusual spelling that review CAN see, and none has
 * an instance here. These scans raise the cost of a dodge; they do not make one
 * impossible.
 *
 * kolu carries the same pair of scanners for the same reasons — its
 * `packages/tests/governance/runEdges.ts` and `awaitedFace.ts`, whose widenings
 * this file mirrors.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "bun:test";

/** Every file that may run an Effect at a boundary, with the reason it is
 *  allowed to. Keep this list SHORT — each entry is a place where Effect's
 *  world ends and a Promise/callback world begins, and a migration that grows
 *  this list has stopped drawing a boundary. */
const SANCTIONED = new Map<string, string>([
  [
    "packages/execution/src/common/effectEdge.ts",
    "odu's ONE edge between Effect's world and the Promise world the " +
      "coordinator and CLI are written in. `runUnary` dispatches a unary member " +
      "call; `firstFrame` runs a stream's head; `subscribe` hands back an async " +
      "iterator. All three exist so no consumer re-derives the laziness, " +
      "teardown and dispatch rules — nor invents a second boundary.",
  ],
]);

const IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";
/** The framework's two names for a member face. A local binding of either name
 *  IS the face, whatever its right-hand side was. */
const FACE = "(?:surface|procedures)";
/** `.` or `?.`, with whitespace either side — a face path may wrap a line. */
const DOT = String.raw`\s*\??\.\s*`;
/** A reference path. Admits a CALL segment with no nested parens, so
 *  `client.entry(A).surface` reads as one path — while `runUnary(c.surface.ns
 *  .verb(x))`, whose parens nest, cannot be read as one and so is not one. */
const REF = `${IDENT}(?:${DOT}${IDENT}|\\([^()]*\\))*`;

const RUN_NS = "(?:Effect|Runtime|NodeRuntime)";

/** A run CALL: the namespaced form, with its parens. */
const RUN_CALL = new RegExp(`\\b${RUN_NS}\\s*\\.\\s*run[A-Z][A-Za-z]*\\s*\\(`);

/** `Effect.runPromise` NOT followed by `(` — the alias dodge. `const run =
 *  Effect.runFork; run(program)` makes a run call {@link RUN_CALL} cannot see,
 *  and so does handing the function to something else (`.then(Effect.runPromise)`).
 *  The `\b` before the lookahead matters: without it, `runPromise` would match
 *  inside `runPromiseExit(` and report a real call as an alias. */
const UNCALLED_RUN = new RegExp(
  `\\b${RUN_NS}\\s*\\.\\s*run[A-Z][A-Za-z]*\\b(?!\\s*\\()`,
  "g",
);

/** `const { runPromise } = Effect` — the same dodge spelled as a destructure,
 *  which leaves no `Namespace.run*` text for {@link UNCALLED_RUN} to find. */
const DESTRUCTURED_RUN = new RegExp(
  `\\{[^{}]*\\brun[A-Z][A-Za-z]*\\b[^{}]*\\}\\s*=\\s*${RUN_NS}\\b`,
  "g",
);

/** A named import of a `run*` helper straight off an effect module — the third
 *  way a call site drops the namespace {@link RUN_CALL} keys on. */
const BARE_RUN_IMPORT =
  /import\s*\{[^}]*\brun[A-Z][A-Za-z]*\b[^}]*\}\s*from\s*["']effect[^"']*["']/g;

/** `await`/`void` applied DIRECTLY to a face call, with nothing between but a
 *  reference path. The one legitimate spelling, `await runUnary(<call>)`, does
 *  not match — its parens nest, so {@link REF} cannot swallow it. */
const AWAITED_FACE_CALL = new RegExp(
  `\\b(?:await|void)\\s+${REF}${DOT}${FACE}${DOT}${IDENT}${DOT}${IDENT}\\s*\\(`,
  "g",
);

/** `const <name> = <path>.surface…` — the alias, the stored description and the
 *  bare face handle alike, since all three begin with a face path and only what
 *  trails tells them apart; none of them may be awaited or voided. */
const FACE_BINDING = new RegExp(
  `\\b(?:const|let|var)\\s+(${IDENT})\\s*=\\s*${REF}${DOT}${FACE}\\b`,
  "g",
);

/** `const { verb } = <path>.surface.ns` — every name it binds is face-valued. */
const FACE_DESTRUCTURE = new RegExp(
  `\\b(?:const|let|var)\\s*\\{([^{}]*)\\}\\s*=\\s*${REF}${DOT}${FACE}\\b`,
  "g",
);

/** Any destructure at all — inspected for a binding NAMED `surface` or
 *  `procedures`, which is the face by its own framework name whatever the right
 *  hand side is (`const { surface } = client`). */
const ANY_DESTRUCTURE = /\b(?:const|let|var)\s*\{([^{}]*)\}\s*=/g;

const AWAITED_NAME = new RegExp(`\\b(?:await|void)\\s+(${IDENT})\\b`, "g");

/**
 * Blank comments and string/template literals, replacing them with spaces so
 * every offset and line number still lines up with the original source.
 *
 * A character scan rather than a regex, because `//` inside a string literal
 * (every URL in this repo) and a quote inside a comment both defeat the regex
 * version. And the blanking is not a loophole — it is the point: each banned
 * shape has to be SPELLABLE in prose so a doc comment can teach it as the wrong
 * answer. This file's header does exactly that, and so does `effectEdge.ts`'s.
 * A check that condemned its own explanation would force the explanation out,
 * which is how the knowledge gets lost.
 *
 * `keepStrings` exists for the bare-import check alone, which has to READ a
 * module specifier — the one question about this source that a string literal
 * is the answer to rather than a hiding place.
 */
function blankNonCode(source: string, keepStrings = false): string {
  const out = source.split("");
  let i = 0;
  const blankTo = (end: number): void => {
    for (let j = i; j < end && j < out.length; j++)
      if (out[j] !== "\n") out[j] = " ";
    i = end;
  };
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const nl = source.indexOf("\n", i);
      blankTo(nl === -1 ? source.length : nl);
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      blankTo(end === -1 ? source.length : end + 2);
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      // The quote characters themselves are ordinary code; only the contents go.
      i += 1;
      if (!keepStrings) blankTo(j - 1);
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** The names a destructuring pattern binds: `{ a, b: c, ...rest }` → a, c, rest. */
function boundNames(pattern: string): string[] {
  const names: string[] = [];
  for (const part of pattern.split(",")) {
    const target = part.includes(":")
      ? (part.split(":").pop() ?? "")
      : part.replace("...", "");
    const name = new RegExp(`^\\s*(${IDENT})`).exec(target)?.[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

const lineOf = (code: string, index: number): number =>
  code.slice(0, index).split("\n").length;

const cite = (rel: string, code: string, index: number, text: string): string =>
  `${rel}:${lineOf(code, index)}: ${text.replace(/\s+/g, " ").trim()}`;

/** Nothing to police: installed or generated trees, and the e2e fixture repos,
 *  which are throwaway inputs rather than odu's own source. */
const SKIPPED = new Set(["node_modules", "dist", "fixtures"]);

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIPPED.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...tsFilesUnder(path));
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(path);
  }
  return out;
}

const repoRoot = join(import.meta.dirname, "..", "..");

interface Scanned {
  /** Repo-relative path, POSIX separators. */
  readonly rel: string;
  /** Comments AND string literals blanked — what a real call must survive. */
  readonly code: string;
  /** Comments blanked, string literals kept — for the one check that reads a
   *  module specifier. */
  readonly codeWithStrings: string;
}

/** Every scanned file, sorted, already blanked both ways. */
function scannedSources(): Scanned[] {
  const files: string[] = [];
  for (const root of ["src", "tests", "packages"])
    files.push(...tsFilesUnder(join(repoRoot, root)));
  return files
    .map((full) => relative(repoRoot, full).split(sep).join("/"))
    .sort()
    .map((rel) => {
      const source = readFileSync(join(repoRoot, rel), "utf-8");
      return {
        rel,
        code: blankNonCode(source),
        codeWithStrings: blankNonCode(source, true),
      };
    });
}

const isTestFile = (rel: string): boolean =>
  rel.endsWith(".test.ts") || rel.endsWith(".test-d.ts");

describe("Effect.run* edge discipline", () => {
  const sources = scannedSources();

  it("runs effects only at the sanctioned boundaries", () => {
    const offenders: string[] = [];
    for (const { rel, code } of sources) {
      // Test files are their own edge: a test IS a Promise-shaped harness, and
      // pinning where a suite runs an effect would pin the suite's mechanism
      // rather than the source's boundary.
      if (isTestFile(rel)) continue;
      if (!RUN_CALL.test(code)) continue;
      if (SANCTIONED.has(rel)) continue;
      offenders.push(rel);
    }
    expect(
      offenders,
      `${offenders.join(", ")} runs an Effect outside the sanctioned edges. ` +
        "That makes the file an Effect boundary. If it should be one, add it " +
        "to SANCTIONED with the reason; if it should not, hand the Effect to a " +
        "caller that already is one (a surface handler returns an Effect; a " +
        "Stream consumer goes through common/effectEdge.ts).",
    ).toEqual([]);
  });

  it("never names a run function without calling it — an alias travels", () => {
    // The scan above keys on `Effect.run*(`. Three spellings drop that key
    // while still running an effect, and each is banned OUTRIGHT rather than
    // enumerated: an alias can be invoked anywhere, so there is no one file to
    // hang an allowance on. Test files are in scope here — the exemption above
    // is a licence to RUN an effect, not to hide where the run happens.
    const offenders: string[] = [];
    for (const { rel, code, codeWithStrings } of sources) {
      for (const pattern of [UNCALLED_RUN, DESTRUCTURED_RUN])
        for (const match of code.matchAll(pattern))
          offenders.push(cite(rel, code, match.index, match[0]));
      // The import check alone reads through string literals: the module
      // specifier it must see IS one.
      for (const match of codeWithStrings.matchAll(BARE_RUN_IMPORT))
        offenders.push(cite(rel, codeWithStrings, match.index, match[0]));
    }
    expect(
      offenders,
      `${offenders.join("\n")}\n\nAn Effect \`run*\` function is NAMED here ` +
        "without being called, so the allowlist above could never see the edge " +
        "it makes. Call it in place with the namespace intact — or better, " +
        "compose the effect into a caller that is already Effect-shaped.",
    ).toEqual([]);
  });

  it("never `await`s or `void`s a member-face call, directly or by alias", () => {
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
    // The DIRECT pattern is deliberately narrow — `await`/`void` applied to a
    // face call with nothing between but a reference path — so the one
    // legitimate spelling, `await runUnary(client.surface.ns.verb(x))`, does
    // not match. That restraint is the design: a check that condemned the
    // sanctioned form would be switched off within a week, and then the real
    // ones ride back in.
    //
    // What the direct pattern misses is a RENAME. Bind the face to a name first
    // and the path is gone from the awaiting line, while the silence is
    // identical. So every name bound to something that starts as a face path is
    // marked, and awaiting or voiding a marked name is a hit. Marking rather
    // than banning the binding, because a face bound and then CALLED or
    // composed is perfectly legitimate — and a rule that was merely loud would
    // be switched off just as fast as one that was wrong.
    const offenders: string[] = [];
    for (const { rel, code } of sources) {
      for (const match of code.matchAll(AWAITED_FACE_CALL))
        offenders.push(cite(rel, code, match.index, match[0]));

      /** Face-valued name → the line it was bound on, so a hit can cite it. */
      const faceBound = new Map<string, number>();
      const bind = (name: string, index: number): void => {
        if (!faceBound.has(name)) faceBound.set(name, lineOf(code, index));
      };
      for (const match of code.matchAll(FACE_BINDING))
        bind(match[1] ?? "", match.index);
      for (const match of code.matchAll(FACE_DESTRUCTURE))
        for (const name of boundNames(match[1] ?? "")) bind(name, match.index);
      for (const match of code.matchAll(ANY_DESTRUCTURE))
        for (const name of boundNames(match[1] ?? ""))
          if (name === "surface" || name === "procedures")
            bind(name, match.index);

      for (const match of code.matchAll(AWAITED_NAME)) {
        const name = match[1] ?? "";
        const boundAt = faceBound.get(name);
        if (boundAt === undefined) continue;
        offenders.push(
          cite(
            rel,
            code,
            match.index,
            `${match[0]} — \`${name}\` is bound to a member face at line ${boundAt}`,
          ),
        );
      }
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
    const byPath = new Map(sources.map(({ rel, code }) => [rel, code]));
    const stale: string[] = [];
    for (const rel of SANCTIONED.keys()) {
      const code = byPath.get(rel);
      if (code === undefined || !RUN_CALL.test(code)) stale.push(rel);
    }
    expect(stale).toEqual([]);
  });
});
