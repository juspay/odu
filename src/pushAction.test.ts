/**
 * THE PUSH ACTION'S TWO MECHANICAL RULES.
 *
 * **One: no workflow expression may appear in an `action.yml`** except where
 * the action itself is wired. GitHub evaluates `${{ … }}` while PARSING the
 * file — in descriptions, in comments, in any string — and while parsing, the
 * `github` context does not exist. One such expression refuses the WHOLE
 * action with `Unrecognized named-value: github`, so every repository that
 * uses it goes red at once, before a single step runs. That is what happened
 * to kolu, olai and agent-distro the day this action's `pin:` description
 * documented its own one-line example.
 *
 * The rule is narrow because the failure is: an expression in `action.yml`
 * may name `inputs.` and nothing else. `inputs` is the one context an
 * action's own `runs:` is evaluated with; everything a CALLER writes —
 * `github`, `secrets`, `matrix` — belongs in a workflow, and in the README
 * where it can be read.
 *
 * **Two: an omitted `cache:` pushes to a NAMED target, with the token** (#163).
 * The documented spelling used to resolve the substituter inside
 * `odu cache push`, which withholds `$ODU_CACHE_TOKEN` from an address a
 * repository named (#159, SEC-5) — so every such push went out anonymous and
 * the bucket answered 401. `push.sh` now asks `odu cache target` and hands the
 * URL back as `--cache`, and these run the real script against a stub `odu` to
 * say so: the token is there, and a flake that names no odu cache (or two)
 * fails the STEP with odu's own sentence rather than reaching a bucket.
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ACTIONS = join(import.meta.dirname, "..", ".github", "actions");
const PUSH_SH = join(ACTIONS, "push", "push.sh");

/** Every `action.yml` this repository ships. */
const actionFiles = (): string[] =>
  readdirSync(ACTIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(ACTIONS, entry.name, "action.yml"));

/** Every `${{ … }}` in a file, with the line it sits on. */
function expressions(source: string): { line: number; text: string }[] {
  return source.split("\n").flatMap((line, at) =>
    [...line.matchAll(/\$\{\{([^}]*)\}\}/g)].map((found) => ({
      line: at + 1,
      text: (found[1] ?? "").trim(),
    })),
  );
}

describe("the action files this repository ships", () => {
  it("name only `inputs` in an expression, because the rest refuses the action", () => {
    const files = actionFiles();
    // Non-vacuity: there IS an action to check, and it DOES use expressions.
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.flatMap((file) =>
      expressions(readFileSync(file, "utf-8"))
        .filter((found) => !found.text.startsWith("inputs."))
        .map((found) => `${file}:${found.line}: \${{ ${found.text} }}`),
    );
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : "an action.yml may only interpolate `inputs.…`; GitHub evaluates every other " +
          "expression at parse time, where `github` and `secrets` do not exist, and refuses " +
          "the whole action. Describe it in words here and keep the literal line in the README:\n" +
          offenders.join("\n"),
    ).toEqual([]);
    expect(
      files.some((file) => expressions(readFileSync(file, "utf-8")).length > 0),
    ).toBe(true);
  });
});

/** What a run of `push.sh` left behind: how it ended, what it said, and the
 *  calls the stub `odu` saw. */
interface Ran {
  status: number;
  output: string;
  /** One line per `odu` invocation: the argv, joined. */
  calls: string[];
  /** `$ODU_CACHE_TOKEN` as the stub saw it, per invocation. */
  tokens: string[];
}

/**
 * RUN THE REAL `push.sh`, with the two things it shells out to replaced.
 *
 * `nix` answers the ONE build this path takes — the pusher, `<repo>#odu` —
 * with a directory holding a stub `bin/odu`; nothing else is stubbed, because
 * an absolute store path in `paths:` is passed through without a build. The
 * stub `odu` records its argv and the token in its environment, then answers
 * `cache target` and `cache push` the way odu does.
 *
 * `served: []` is what ends the script after the push: with no path for the
 * bucket to serve there is nothing to verify, so `check.sh` and curl never
 * run and the test needs no substituter of its own.
 */
function runPush(options: {
  /** What `odu cache target` prints, or the refusal it exits 1 with. */
  target: { ok: string } | { refuses: string };
  env?: Record<string, string>;
}): Ran {
  const work = mkdtempSync(join(tmpdir(), "odu-push-action-"));
  try {
    const record = join(work, "calls");
    const bin = join(work, "bin");
    const oduBin = join(work, "pusher", "bin");
    mkdirSync(bin, { recursive: true });
    mkdirSync(oduBin, { recursive: true });

    const answer =
      "ok" in options.target
        ? `printf '%s\\n' ${JSON.stringify(options.target.ok)}; exit 0`
        : `printf 'odu: %s\\n' ${JSON.stringify(options.target.refuses)} >&2; exit 1`;
    writeFileSync(
      join(oduBin, "odu"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> ${JSON.stringify(record)}
printf 'token=%s\\n' "\${ODU_CACHE_TOKEN:-}" >> ${JSON.stringify(record)}
case "$1 $2" in
  "cache target") ${answer} ;;
  "cache push")
    printf '%s' '{"pushed":1,"alreadyPresent":0,"skippedUpstream":0,"failed":0,"failures":[],"pageUrl":"https://odu.example/cache/main","substituter":"https://cache.example.com/main","served":[],"pinned":null}'
    exit 0 ;;
esac
printf 'stub odu: unexpected %s\\n' "$*" >&2
exit 2
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "nix"),
      `#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    *"#odu") printf '%s\\n' ${JSON.stringify(join(work, "pusher"))}; exit 0 ;;
  esac
done
printf 'stub nix: unexpected %s\\n' "$*" >&2
exit 2
`,
      { mode: 0o755 },
    );
    chmodSync(join(bin, "nix"), 0o755);
    chmodSync(join(oduBin, "odu"), 0o755);

    let status = 0;
    let output = "";
    try {
      output = execFileSync("bash", [PUSH_SH], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          HOME: work,
          RUNNER_TEMP: work,
          ODU_PUSH_CACHE: "",
          ODU_PUSH_TOKEN: "odu_write_token",
          ODU_PUSH_PATHS: "/nix/store/0000000000000000000000000000000a-example",
          ODU_PUSH_PIN: "",
          GITHUB_EVENT_NAME: "push",
          ...(options.env ?? {}),
        },
      });
    } catch (err) {
      const failed = err as { status?: number; stdout?: string; stderr?: string };
      status = failed.status ?? 1;
      output = `${failed.stdout ?? ""}${failed.stderr ?? ""}`;
    }
    const lines = readFileSync(record, "utf-8").trim().split("\n").filter(Boolean);
    return {
      status,
      output,
      calls: lines.filter((line) => !line.startsWith("token=")),
      tokens: lines.filter((line) => line.startsWith("token=")).map((line) => line.slice(6)),
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

describe("the push action with no `cache:` input", () => {
  it("asks the flake for the target and pushes to it BY NAME, with the token", () => {
    const ran = runPush({ target: { ok: "https://cache.example.com/main" } });
    expect(ran.status, ran.output).toBe(0);
    expect(ran.calls[0]).toBe("cache target");
    // THE WHOLE POINT OF #163: the push NAMES the URL, which is the spelling
    // `odu cache push` sends a token with. An inferred target would not be.
    expect(ran.calls[1]).toContain("cache push --cache https://cache.example.com/main");
    expect(ran.tokens[1]).toBe("odu_write_token");
  });

  it("drops a trailing slash before naming it, so the bucket is addressed once", () => {
    const ran = runPush({ target: { ok: "https://cache.example.com/main/" } });
    expect(ran.status, ran.output).toBe(0);
    expect(ran.calls[1]).toContain("--cache https://cache.example.com/main ");
  });

  it("fails the STEP with odu's own sentence when the flake names no odu cache", () => {
    const ran = runPush({
      target: {
        refuses:
          "no substituter in ./flake.nix nixConfig answered as an odu cache — a PRIVATE bucket answers its nix-cache-info to nobody, so name it with `--cache <substituter>`",
      },
    });
    expect(ran.status).not.toBe(0);
    expect(ran.output).toContain("no substituter in ./flake.nix nixConfig answered");
    expect(ran.output).toContain("::error::");
    // NOT A 401: nothing was pushed at all, so no bucket was asked anonymously.
    expect(ran.calls).toEqual(["cache target"]);
  });

  it("fails the STEP when the flake names two odu caches", () => {
    const ran = runPush({
      target: {
        refuses:
          "./flake.nix nixConfig names 2 odu caches (https://a.example/one, https://b.example/two) — a repository pushes to one, so name it with `--cache <substituter>`",
      },
    });
    expect(ran.status).not.toBe(0);
    expect(ran.output).toContain("names 2 odu caches");
    expect(ran.calls).toEqual(["cache target"]);
  });

  it("asks nothing of the flake when the workflow named a cache itself", () => {
    const ran = runPush({
      target: { refuses: "this must never be reached" },
      env: { ODU_PUSH_CACHE: "https://named.example/bucket" },
    });
    expect(ran.status, ran.output).toBe(0);
    expect(ran.calls).toHaveLength(1);
    expect(ran.calls[0]).toContain("cache push --cache https://named.example/bucket");
    expect(ran.tokens[0]).toBe("odu_write_token");
  });
});
