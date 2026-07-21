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

/** The platform set protection covers. Unlike `run`, protect never dials a
 *  host — it only needs platform KEYS to fan out contexts — so explicit
 *  `--platform` flags stand on their own with no hosts config at all
 *  (juspay/odu#52; routing them through `run`'s lane resolver demanded a host
 *  per platform). With no flags the set derives from the hosts config, which
 *  is machine-local while protection is repo-global — that once silently
 *  halved a repo's required contexts, so the derivation names its source. */
function protectPlatforms(explicit: readonly string[]): string[] | null {
  if (explicit.length > 0) return [...new Set(explicit)].sort();
  const config = loadHosts();
  const platforms = Object.keys(config.hosts).sort();
  if (platforms.length === 0) {
    process.stderr.write(
      "odu: protect found no platforms — pass --platform PLAT (repeatable)\n" +
        "     to name the repo's CI platforms, or configure a hosts file\n",
    );
    return null;
  }
  process.stderr.write(
    `odu: protect: platform set (${platforms.join(", ")}) derives from\n` +
      `     ${config.source} — a machine-local hosts config, not a repo\n` +
      "     fact; pass --platform to pin the repo's platform set explicitly\n",
  );
  return platforms;
}

export async function protectCommand(args: ProtectArgs): Promise<number> {
  const repoRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf-8",
  }).stdout.trim();
  const spec = loadJustPipeline(repoRoot);
  const platforms = protectPlatforms(args.platforms);
  if (platforms === null) return 1;
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
