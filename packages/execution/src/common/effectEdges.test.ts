import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "bun:test";

const SANCTIONED = new Map<string, string>([
  [
    "packages/execution/src/common/effectEdge.ts",
    "odu's ONE edge between Effect's world and the Promise world the " +
      "coordinator and CLI are written in. `runUnary` dispatches a unary member " +
      "call; `firstFrame` runs a stream's head; `subscribe` hands back an async " +
      "iterator. All three exist so no consumer re-derives the laziness, " +
      "teardown and dispatch rules — nor invents a second boundary.",
  ],
  [
    "packages/cli/src/serviceCli.ts",
    "The generated CLI face's PROCESS EDGE. `@kolu/surface-cli` returns command " +
      "VALUES and runs no program, so the host owns the run — and here the host " +
      "hands the whole tree to `NodeRuntime.runMain`, which writes the failure's " +
      "own line and maps the verdict to one of the five documented exit codes. " +
      "An argv face's last act is to end the process, so it is an edge by " +
      "construction.",
  ],
  [
    "packages/host/src/web.ts",
    "The web daemon's COMPOSITION ROOT. `serveSurfaceApp` is an Effect over a " +
      "Scope — the listener's whole teardown hangs off it — and the survivable " +
      "spawn driver is an Effect value, while `daemonMain` and odu's own argv " +
      "dispatch are Promise-shaped. This file is that crossing, and the only " +
      "one that may open and close the listener's scope.",
  ],
  [
    "packages/web-ui/src/app.tsx",
    "The BROWSER's UI edge. A surface procedure is an `Effect` — a description — " +
      "and a click is the moment one becomes execution, so this file's `run` " +
      "helper is where that crossing happens for every control on the page. ONE " +
      "helper rather than a run per button, which is what keeps a control's " +
      "whole story (pending → receipt or refusal) in one function; the views " +
      "themselves take callbacks and hold no client at all.",
  ],
  [
    "packages/cli/src/serviceFace.ts",
    "The public commands' EDGE, and the reason it is ONE file for all of them. " +
      "Every public command is a client of the shared service, so each ends " +
      "with a surface procedure — an `Effect` carrying a declared " +
      "`ServiceRefused` channel — becoming bytes on a stream and a number for " +
      "`process.exit`. `call` is where that happens, once, which is also what " +
      "keeps a REFUSAL apart from a dead link: both arrive on one error " +
      "channel and they must not become the same exit. The four command " +
      "modules that import it (`serviceCommands`, `serviceStatus`, " +
      "`serviceVenue`, `servicePipeline`) are four SUBJECTS, not four edges — " +
      "which is exactly the property this entry exists to hold, because a " +
      "second `Effect.runPromise` in any of them would be a second answer to " +
      "what a refusal means.",
  ],
  [
    "packages/cache/src/cli.ts",
    "A FACE's edge, and the cache's only one. `odu cache use` ends with a " +
      "surface procedure — an `Effect` carrying a declared `CacheRefused` " +
      "channel — becoming a number for `process.exit`, and the three outcomes " +
      "a caller must keep apart (answered / refused / dead link) cannot be " +
      "told apart without running it. The row's own doors take the edge's " +
      "place in production: `./server` is a handler table, and the daemon " +
      "runs it. The admin commands that used to share this edge are gone " +
      "(PLAN 2.10): a bucket is administered from the board, or through " +
      "`odu surface cache …`, whose edge is the generated face's.",
  ],
  [
    "packages/auth/src/routes.ts",
    "The door's HTTP edge, and it is the SIGN-IN FLOW's: `HttpRouter` handlers " +
      "answer with an `Effect` and a `Layer`, and a cookie is set on a response " +
      "by an `Effect` combinator (`setCookie`). The router runs its own effects; " +
      "the ONE crossing this file makes is a cookie set inside an already-" +
      "effectful handler, which is exactly where the response value lives.",
  ],
  [
    "packages/launch/src/webLauncher.ts",
    "Converging on the singleton. Reading the service cell and asking a running " +
      "daemon to drain are Effects; everything that decides between adopt, " +
      "spawn and refuse is ordinary Promise code a test drives without a " +
      "runtime. The two are joined here rather than leaking `Effect` into every " +
      "branch of that decision.",
  ],
  [
    "packages/service-client/src/socket.ts",
    "The LOCAL dial, which is Promise-shaped by contract — a link constructor " +
      "every face awaits — and which now adopts or refuses the daemon it " +
      "reached before handing the connection over. That handshake is one read " +
      "of the `service` cell, an Effect, and running it HERE is what removes " +
      "the comparison from every consumer: the alternative is a dial that " +
      "answers with an unqualified link and N callers each running that same " +
      "Effect and each deciding for itself what a skew means. It cannot route " +
      "through `common/effectEdge.ts`: this package is browser-safe and " +
      "depends on `@odu/run-client`, `@odu/run-history` and `effect` alone, so " +
      "an edge in `@odu/execution` would point the dependency backwards.",
  ],
]);

const IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";
const FACE = "(?:surface|procedures)";
const DOT = String.raw`\s*\??\.\s*`;
const NO_NESTED_PARENS = String.raw`[^()]*`;
const CALL_SEGMENT = String.raw`\(${NO_NESTED_PARENS}\)`;
const REF = `${IDENT}(?:${DOT}${IDENT}|${CALL_SEGMENT})*`;

const RUN_NS = "(?:Effect|Runtime|NodeRuntime)";
const RUN_FN_NAME = String.raw`run[A-Z][A-Za-z]*\b`;

const RUN_CALL = new RegExp(`\\b${RUN_NS}\\s*\\.\\s*${RUN_FN_NAME}\\s*\\(`);

const UNCALLED_RUN = new RegExp(
  `\\b${RUN_NS}\\s*\\.\\s*${RUN_FN_NAME}(?!\\s*\\()`,
  "g",
);

const DESTRUCTURED_RUN = new RegExp(
  `\\{[^{}]*\\b${RUN_FN_NAME}[^{}]*\\}\\s*=\\s*${RUN_NS}\\b`,
  "g",
);

const BARE_RUN_IMPORT =
  /import\s*\{[^}]*\brun[A-Z][A-Za-z]*\b[^}]*\}\s*from\s*["']effect[^"']*["']/g;

const AWAITED_FACE_CALL = new RegExp(
  `\\b(?:await|void)\\s+${REF}${DOT}${FACE}${DOT}${IDENT}${DOT}${IDENT}\\s*\\(`,
  "g",
);

const FACE_BINDING = new RegExp(
  `\\b(?:const|let|var)\\s+(${IDENT})\\s*=\\s*${REF}${DOT}${FACE}\\b`,
  "g",
);

const FACE_DESTRUCTURE = new RegExp(
  `\\b(?:const|let|var)\\s*\\{([^{}]*)\\}\\s*=\\s*${REF}${DOT}${FACE}\\b`,
  "g",
);

const ANY_DESTRUCTURE = /\b(?:const|let|var)\s*\{([^{}]*)\}\s*=/g;

const AWAITED_NAME = new RegExp(`\\b(?:await|void)\\s+(${IDENT})\\b`, "g");

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
      i += 1;
      if (!keepStrings) blankTo(j - 1);
      i = j;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

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

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

interface Scanned {
  readonly rel: string;
  readonly codeStringsBlanked: string;
  readonly codeStringsKept: string;
}

function scannedSources(): Scanned[] {
  const files: string[] = [];
  for (const root of ["src", "tests", "packages"]) {
    const dir = join(repoRoot, root);
    if (!existsSync(dir))
      throw new Error(
        `effect-edge scan root is missing: ${dir} — repoRoot resolved to ${repoRoot}`,
      );
    files.push(...tsFilesUnder(dir));
  }
  return files
    .map((full) => relative(repoRoot, full).split(sep).join("/"))
    .sort()
    .map((rel) => {
      const source = readFileSync(join(repoRoot, rel), "utf-8");
      return {
        rel,
        codeStringsBlanked: blankNonCode(source),
        codeStringsKept: blankNonCode(source, true),
      };
    });
}

const isTestFile = (rel: string): boolean =>
  rel.endsWith(".test.ts") || rel.endsWith(".test-d.ts");

describe("Effect.run* edge discipline", () => {
  // Scanned on FIRST USE, not in the describe body: a throw out here is
  // reported by bun as an "unhandled error between tests" and leaves the tally
  // at `0 fail`, while inside an `it` the same throw is a named failure.
  let scanned: Scanned[] | undefined;
  const sources = (): Scanned[] => (scanned ??= scannedSources());

  it("runs effects only at the sanctioned boundaries", () => {
    const offenders: string[] = [];
    for (const { rel, codeStringsBlanked } of sources()) {
      if (isTestFile(rel)) continue;
      if (!RUN_CALL.test(codeStringsBlanked)) continue;
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
    const offenders: string[] = [];
    for (const { rel, codeStringsBlanked, codeStringsKept } of sources()) {
      for (const pattern of [UNCALLED_RUN, DESTRUCTURED_RUN])
        for (const match of codeStringsBlanked.matchAll(pattern))
          offenders.push(
            cite(rel, codeStringsBlanked, match.index, match[0]),
          );
      for (const match of codeStringsKept.matchAll(BARE_RUN_IMPORT))
        offenders.push(cite(rel, codeStringsKept, match.index, match[0]));
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
    const offenders: string[] = [];
    for (const { rel, codeStringsBlanked: code } of sources()) {
      for (const match of code.matchAll(AWAITED_FACE_CALL))
        offenders.push(cite(rel, code, match.index, match[0]));

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
    const byPath = new Map(
      sources().map(({ rel, codeStringsBlanked }) => [rel, codeStringsBlanked]),
    );
    const stale: string[] = [];
    for (const rel of SANCTIONED.keys()) {
      const code = byPath.get(rel);
      if (code === undefined || !RUN_CALL.test(code)) stale.push(rel);
    }
    expect(stale).toEqual([]);
  });
});
