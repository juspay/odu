/**
 * `odu protect` — PATCH GitHub branch-protection's required_status_checks to
 * the (recipe × platform) contexts the canonical DAG produces, justci's
 * `protect` equivalent. `--dry-run` prints the contexts without touching the
 * API. The bookkeeping `_ci-setup@<platform>` context is posted but never
 * required, matching the protection list observed under justci.
 */

import { spawnSync } from "node:child_process";
import { fanId } from "../common/nodeId";
import { loadHosts } from "../coordinator/hosts";
import { parseGithubRemote } from "../coordinator/statuses";
import { laneTasks, loadJustPipeline } from "../just/ingest";

export interface ProtectArgs {
  dryRun: boolean;
  branch?: string;
  platforms: string[];
}

/** The platform set protection covers, as pure data — the decision writes no
 *  output (its one effect is the hosts-config read on the unsliced path), and
 *  protectCommand owns the stderr/exit at its boundary (mirrors hosts.ts's
 *  pure-refusal factory). `explicit` names came straight from `--platform`;
 *  `derived` came from the hosts config and carries its `source` so the caller
 *  can warn that the set is machine-local, not a repo fact; `none` means
 *  neither produced a platform, with `source` so the refusal can name an
 *  empty-but-present file. */
type PlatformSet =
  | { kind: "explicit"; platforms: string[] }
  | { kind: "derived"; platforms: string[]; source: string }
  | { kind: "none"; source: string };

/** Unlike `run`, protect never dials a host — it only needs platform KEYS to
 *  fan out contexts — so explicit `--platform` flags stand on their own with no
 *  hosts config at all (juspay/odu#52; routing them through `run`'s lane
 *  resolver demanded a host per platform). With no flags the set derives from
 *  the hosts config, which is machine-local while protection is repo-global —
 *  that once silently halved a repo's required contexts, so the derivation
 *  names its source. */
function protectPlatforms(explicit: readonly string[]): PlatformSet {
  if (explicit.length > 0) {
    // A blank value (`--platform=`) would fan out contexts like `alpha@` and,
    // un-dry-run, PATCH them into protection — the host lookup that used to
    // reject it incidentally is gone, so refuse it on purpose.
    for (const platform of explicit) {
      if (platform.trim() === "") {
        throw new Error(
          "odu: --platform expects a Nix system tuple (e.g. x86_64-linux), got an empty value",
        );
      }
    }
    return { kind: "explicit", platforms: [...new Set(explicit)].sort() };
  }
  const config = loadHosts();
  const platforms = Object.keys(config.hosts).sort();
  if (platforms.length === 0) return { kind: "none", source: config.source };
  return { kind: "derived", platforms, source: config.source };
}

export async function protectCommand(args: ProtectArgs): Promise<number> {
  const repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  }).stdout.trim();
  const spec = loadJustPipeline(repoRoot);
  const set = protectPlatforms(args.platforms);
  if (set.kind === "none") {
    // Mirror noHostsConfiguredError's why-branch: `source` names the file that
    // won or "(no hosts file)" when none existed, so an empty-but-present hosts
    // file is diagnosed as such rather than told to "configure" one it has.
    const why =
      set.source === "(no hosts file)"
        ? "     to name the repo's CI platforms, or configure a hosts file\n"
        : `     to name the repo's CI platforms — ${set.source} configured no platform\n`;
    process.stderr.write(
      "odu: protect found no platforms — pass --platform PLAT (repeatable)\n" +
        why,
    );
    return 1;
  }
  if (set.kind === "derived") {
    process.stderr.write(
      `odu: protect: platform set (${set.platforms.join(", ")}) derives from\n` +
        `     ${set.source} — a machine-local hosts config, not a repo\n` +
        "     fact; pass --platform to pin the repo's platform set explicitly\n",
    );
  }
  const platforms = set.platforms;
  // Require exactly the contexts `odu run` posts: each platform's lane after
  // OS-attribute filtering (a [linux]-only recipe is never posted on a darwin
  // lane, so it must not be required there or protection waits forever).
  const contexts = platforms.flatMap((platform) =>
    laneTasks(spec, platform, [], false).map((task) => fanId(task.id, platform)),
  );

  if (args.dryRun) {
    for (const context of contexts) process.stdout.write(`${context}\n`);
    return 0;
  }

  const origin = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: repoRoot,
    encoding: "utf-8",
  }).stdout.trim();
  const github = parseGithubRemote(origin);
  if (github === null) {
    process.stderr.write("odu: protect needs a github.com origin remote\n");
    return 1;
  }
  const branch =
    args.branch ??
    spawnSync(
      "gh",
      [
        "api",
        `repos/${github.owner}/${github.repo}`,
        "--jq",
        ".default_branch",
      ],
      { encoding: "utf-8" },
    ).stdout.trim();

  const body = JSON.stringify({
    strict: false,
    contexts,
  });
  const result = spawnSync(
    process.env.ODU_GH_BIN ?? "gh",
    [
      "api",
      "--method",
      "PATCH",
      `repos/${github.owner}/${github.repo}/branches/${branch}/protection/required_status_checks`,
      "--input",
      "-",
    ],
    { input: body, encoding: "utf-8" },
  );
  if (result.status !== 0) {
    process.stderr.write(`odu: protect PATCH failed:\n${result.stderr}`);
    return 1;
  }
  process.stdout.write(
    `odu: required_status_checks on ${branch} set to ${contexts.length} contexts\n`,
  );
  return 0;
}
