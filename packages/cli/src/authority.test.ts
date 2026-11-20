import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "bun:test";
import ts from "typescript";

const packageRoot = join(import.meta.dirname, "..");

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
    }
  }
  return found;
})();

const SELF = "packages/cli";
const REPO = join(packageRoot, "..", "..");

const mainImports = specifiersIn(
  readFileSync(join(REPO, "src", "main.ts"), "utf-8"),
  "src/main.ts",
);

const reachedFromMain = mainImports
  .filter((s) => s.startsWith("@odu/cli/"))
  .map((s) => `${s.slice("@odu/cli/".length)}.ts`)
  .sort();

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
  // instances on the right-hand side are replaced.
  return join(dir, sub === "" ? literal : literal.replace(/\*/g, sub));
}

const WALK_STOPS_AT: readonly string[] = [
  "internalCli.ts",
];

const FACE_PACKAGES = ["packages/cli", "packages/cache", "packages/launch"] as const;

type FileRole = "face" | "engine";

const roleOf = (file: string): FileRole =>
  file === "src/main.ts" ||
  FACE_PACKAGES.some((one) => file.startsWith(`${one}/`))
    ? "face"
    : "engine";

const PUBLIC_CLIENTS = reachedFromMain.filter(
  (f) => !WALK_STOPS_AT.includes(f),
);

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

const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "packages/launch/src/webDaemonLaunch.ts": ["@odu/execution/coordinator/spawn"],
};

function specifiersIn(source: string, fileName: string): string[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
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

function closureOf(entries: readonly string[]): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = entries.map((file) => (file.includes("/") ? file : `${SELF}/src/${file}`));
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    const specifiers = specifiersIn(readFileSync(join(REPO, file), "utf-8"), file);
    seen.set(file, specifiers);
    for (const spec of specifiers) {
      const local = resolveToRepoFile(spec, file);
      if (local !== null) queue.push(local);
    }
  }
  return seen;
}

function resolveToRepoFile(
  specifier: string,
  from = "src/main.ts",
): string | null {
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
  return firstOf([normalized, `${normalized}.ts`, `${normalized}.tsx`]);
}

function normalize(file: string): string {
  const parts: string[] = [];
  for (const part of file.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function firstOf(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    try {
      readFileSync(join(REPO, candidate), "utf-8");
      return candidate;
    } catch {
    }
  }
  return null;
}

describe("the authority wall", () => {
  const crossPackageEntries = new Set(
    mainImports
      .filter((s) => s.startsWith("@odu/"))
      .filter((s) => !WALK_STOPS_AT.some((root) => s === `@odu/cli/${root.slice(0, -3)}`))
      .map((s) => resolveToRepoFile(s, "src/main.ts"))
      .filter((file): file is string => file !== null),
  );
  const closure = closureOf([...PUBLIC_CLIENTS, ...crossPackageEntries]);
  const policed = new Map(closure).set("src/main.ts", mainImports);

  it("has public clients to police", () => {
    expect(closure.size).toBeGreaterThanOrEqual(PUBLIC_CLIENTS.length);
    expect([...closure.keys()]).toContain("packages/cli/src/serviceCommands.ts");
    expect(reachedFromMain).toContain("ciCli.ts");
    expect(closure.size).toBeGreaterThan(5);
  });

  it("keeps the exempt set exactly this one, and no more", () => {
    expect(
      [...WALK_STOPS_AT].sort(),
      "WALK_STOPS_AT changed. Every name here is a module the wall STOPS " +
        "walking, so adding one removes it and everything it imports from the " +
        "policed set. That is occasionally right — `internalCli.ts` really is " +
        "the coordinator and its holder — and it is never something to do in " +
        "passing. The daemon root used to be the other one; it left this " +
        "package for `@odu/host`, together with the spawn allowance that stood " +
        "beside it, so neither is this file's to name any more.",
    ).toEqual(["internalCli.ts"]);
  });

  it("names no service root that main.ts has stopped importing", () => {
    for (const root of WALK_STOPS_AT) {
      expect(
        reachedFromMain,
        `WALK_STOPS_AT names ${root}, which src/main.ts no longer imports — ` +
          "remove the exemption or restore the import.",
      ).toContain(root);
    }
  });

  it("walls every command the usage text advertises", () => {
    for (const face of ["ciCli.ts", "serviceCli.ts", "serviceMcp.ts"]) {
      expect(
        PUBLIC_CLIENTS,
        `${face} is a public face and must be reachable from src/main.ts`,
      ).toContain(face);
    }
    for (const face of [
      "serviceCommands.ts",
      "serviceStatus.ts",
      "serviceVenue.ts",
      "servicePipeline.ts",
    ]) {
      expect(
        [...closure.keys()],
        `${face} is a public face and must be walled — reached through the ` +
          "runs' row's door (./ciCli), which src/main.ts imports",
      ).toContain(`packages/cli/src/${face}`);
    }
  });

  it("lets no public client reach execution, the catalog, or a checkout dial", () => {
    const offenders: string[] = [];
    for (const [file, specifiers] of policed) {
      if (roleOf(file) !== "face") continue;
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
    expect(
      ALLOWED,
      "an allowance was added into the public CLI. The daemon's spawn machinery " +
        "lives in @odu/launch; a client that needs a coordinator module is a " +
        "client holding authority the service owns.",
    ).toEqual({ "packages/launch/src/webDaemonLaunch.ts": ["@odu/execution/coordinator/spawn"] });
  });
});
