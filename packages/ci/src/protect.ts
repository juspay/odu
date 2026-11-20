import { spawnSync } from "node:child_process";
import { Result, Schema } from "effect";
import { fanId } from "@odu/run-client/nodeId";
import { loadHosts } from "@odu/execution/coordinator/hosts";
import { parseGithubRemote } from "@odu/execution/coordinator/statuses";
import type { Forge } from "@odu/execution/common/forge";
import type { PipelineSpec } from "@odu/execution/common/spec";
import { laneTasks, loadJustPipeline } from "@odu/execution/just/ingest";
import type { Caller } from "@odu/service/caller";
import type { ProtectFacts, ProtectOutcome } from "@odu/service/ports";
import {
  BranchRulesSchema,
  chooseRuleset,
  createBody,
  CREATED_RULESET_NAME,
  RulesetSchema,
  rulesetId,
  updateBody,
} from "./rulesets";

export interface ProtectArgs {
  dryRun: boolean;
  branch?: string;
  platforms: readonly string[];
  create: boolean;
  checkout: string;
  caller: Caller;
}

type PlatformSet =
  | { kind: "explicit"; platforms: string[] }
  | { kind: "derived"; platforms: string[]; source: string }
  | { kind: "none"; source: string | null };

function protectPlatforms(
  explicit: readonly string[],
  hostsFile: string | null,
): PlatformSet {
  if (explicit.length > 0) {
    if (explicit.some((platform) => platform.trim() === "")) {
      throw new Error(
        "odu: --platform expects a Nix system tuple (e.g. x86_64-linux), got an empty value",
      );
    }
    return { kind: "explicit", platforms: [...new Set(explicit)].sort() };
  }
  const config = loadHosts(hostsFile ?? undefined);
  const platforms = Object.keys(config.hosts).sort();
  if (config.source === null || platforms.length === 0) {
    return { kind: "none", source: config.source };
  }
  return { kind: "derived", platforms, source: config.source };
}

function isCredentialFailure(error: string): boolean {
  const lower = error.toLowerCase();
  return [
    "gh auth login",
    "not logged in",
    "no such host",
    "authentication",
    "bad credentials",
    "http 401",
    "http 403",
    "gh_token",
    "enoent",
    "command not found",
    "not found in $path",
  ].some((hint) => lower.includes(hint));
}

function ghRefusal(
  what: string,
  error: string,
): Extract<ProtectOutcome, { ok: false }> {
  const message = `odu: protect could not ${what}:\n${error}`;
  return isCredentialFailure(error)
    ? { ok: false, code: "no_credential", message, suggestion: ["gh", "auth", "login"] }
    : { ok: false, code: "bad_input", message };
}

function decode<T>(schema: Schema.Codec<T, unknown>, raw: string): T | null {
  try {
    const decoded = Schema.decodeUnknownResult(schema)(
      JSON.parse(raw) as unknown,
    );
    if (Result.isSuccess(decoded)) return decoded.success;
  } catch {
  }
  return null;
}

function unreadable(what: string): Extract<ProtectOutcome, { ok: false }> {
  return {
    ok: false,
    code: "bad_input",
    message: `odu: protect could not read ${what} from gh`,
  };
}

export async function applyProtection(
  args: ProtectArgs,
  forge: Forge,
): Promise<ProtectOutcome> {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: args.checkout,
    encoding: "utf-8",
  });
  const repoRoot = top.status === 0 ? top.stdout.trim() : "";
  if (repoRoot === "") {
    return {
      ok: false,
      code: "checkout_refused",
      message: `odu: protect needs a git checkout — ${args.checkout} is not one`,
    };
  }

  let spec: PipelineSpec;
  try {
    spec = loadJustPipeline(repoRoot);
  } catch (err) {
    return {
      ok: false,
      code: "pipeline_refused",
      message: (err as Error).message,
    };
  }

  let set: PlatformSet;
  try {
    set = protectPlatforms(args.platforms, args.caller.hostsFile);
  } catch (err) {
    return { ok: false, code: "bad_input", message: (err as Error).message };
  }
  if (set.kind === "none") {
    const why =
      set.source === null
        ? "to name the repo's CI platforms, or configure a hosts file"
        : `to name the repo's CI platforms — ${set.source} configured no platform`;
    return {
      ok: false,
      code: "bad_input",
      message:
        `odu: protect found no platforms — pass --platform PLAT (repeatable) ${why}`,
      suggestion: ["odu", "ci", "protect", "--platform", "x86_64-linux"],
    };
  }
  const derivedFrom = set.kind === "derived" ? set.source : null;

  const contexts = set.platforms.flatMap((platform) =>
    laneTasks(spec, platform, [], false).map((task) => fanId(task.id, platform)),
  );

  if (args.dryRun) {
    return {
      ok: true,
      facts: {
        repo: null,
        branch: null,
        contexts,
        derivedFrom,
        rulesetId: null,
        applied: false,
        created: false,
        detail: "dry run — nothing was written, and the forge was not asked",
      },
    };
  }

  const origin = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd: repoRoot,
    encoding: "utf-8",
  }).stdout.trim();
  const github = parseGithubRemote(origin);
  if (github === null) {
    return {
      ok: false,
      code: "checkout_refused",
      message: "odu: protect needs a github.com origin remote",
    };
  }
  const slug = `${github.owner}/${github.repo}`;

  let branch = args.branch;
  if (branch === undefined) {
    const head = await forge.defaultBranch(github);
    if (!head.ok) {
      return ghRefusal(`resolve the default branch of ${slug}`, head.error);
    }
    branch = head.value.trim();
    if (branch === "") {
      return {
        ok: false,
        code: "bad_input",
        message: `odu: protect could not resolve the default branch of ${slug} — name one`,
        suggestion: ["odu", "ci", "protect", "--branch", "main"],
      };
    }
  }

  // Bound to a const because every `facts(...)` below is a closure, and TypeScript
  // does not carry a `let`'s narrowing into one.
  const onBranch = branch;
  const facts = (extra: {
    rulesetId: number | null;
    applied: boolean;
    created: boolean;
    detail: string | null;
  }): ProtectFacts => ({
    repo: slug,
    branch: onBranch,
    contexts,
    derivedFrom,
    ...extra,
  });

  const covering = await forge.readRuleset({ ...github, branch });
  if (!covering.ok) {
    return ghRefusal(`read the rules on ${branch}`, covering.error);
  }
  const branchRules = decode(BranchRulesSchema, covering.value);
  if (branchRules === null) return unreadable(`the rules on ${branch}`);

  const choice = chooseRuleset(branchRules);
  const rulesetUrl = (id: number): string =>
    `https://github.com/${slug}/rules/${id}`;
  switch (choice.kind) {
    case "none": {
      if (!args.create) {
        return {
          ok: false,
          code: "bad_input",
          message:
            `odu: protect found no ruleset covering ${branch} of ${slug} — ` +
            "odu requires checks through a repository ruleset; ask for one to " +
            `be created, or create it under Settings → Rules with ${branch} ` +
            "in its ref conditions",
          suggestion: ["odu", "ci", "protect", "--create"],
        };
      }
      const made = await forge.createRuleset({
        ...github,
        body: createBody({
          branch,
          isDefault: args.branch === undefined,
          contexts,
        }),
      });
      if (!made.ok) {
        return ghRefusal(`create a ruleset on ${branch}`, made.error);
      }
      const id = rulesetId(made.value);
      return {
        ok: true,
        facts: facts({
          rulesetId: id,
          applied: true,
          created: true,
          detail:
            `created ruleset "${CREATED_RULESET_NAME}" — nobody bypasses it, ` +
            "admins included; add bypass actors under Settings → Rules if you " +
            "need them",
        }),
      };
    }
    case "ambiguous":
      return {
        ok: false,
        code: "bad_input",
        message:
          `odu: protect found ${choice.ids.length} rulesets requiring status checks on ${branch}:\n` +
          `${choice.ids.map((id) => `       ${rulesetUrl(id)}\n`).join("")}` +
          "     GitHub requires the union of them, so writing one would leave the\n" +
          "     others' contexts required and blocking — keep required_status_checks\n" +
          "     on exactly one ruleset",
      };
    case "foreign": {
      const owner = choice.source === "" ? choice.sourceType : choice.source;
      return {
        ok: false,
        code: "bad_input",
        message:
          `odu: protect cannot edit the ${choice.sourceType.toLowerCase()} ruleset requiring\n` +
          `     status checks on ${branch} — ${owner} owns it, and a repository\n` +
          `     token cannot write it: ${rulesetUrl(choice.id)}`,
      };
    }
  }

  const read = await forge.readRuleset({ ...github, id: choice.id });
  if (!read.ok) return ghRefusal(`read ruleset ${choice.id}`, read.error);
  const ruleset = decode(RulesetSchema, read.value);
  if (ruleset === null) return unreadable(`ruleset ${choice.id}`);

  const write = await forge.replaceRuleset({
    ...github,
    id: ruleset.id,
    body: updateBody(ruleset, contexts),
  });
  if (!write.ok) return ghRefusal(`write ruleset ${ruleset.id}`, write.error);
  return {
    ok: true,
    facts: facts({
      rulesetId: ruleset.id,
      applied: true,
      created: false,
      detail: `ruleset "${ruleset.name}" (#${ruleset.id}) now requires ${contexts.length} contexts on ${branch}`,
    }),
  };
}

