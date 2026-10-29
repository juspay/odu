/**
 * THE FORGE CONTRACT — one suite, two implementations.
 *
 * A port is only a port if its implementations are interchangeable, and the
 * only way to state that is to run the same assertions against more than one.
 * `ghForge` is driven through a fake `$ODU_GH_BIN` (the e2e suites' own seam, so
 * what this suite exercises is the argv a real `gh` would receive), and the
 * in-memory fake is the shape a suite or a later installation-token
 * implementation fills in.
 *
 * What is deliberately NOT here: credential decisions, refusal wording, and
 * policy. `no_credential` belongs to the caller that knows how to recover from
 * it (`@odu/cli`'s protect), not to the forge that merely reports what `gh`
 * said.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ghForge,
  type Forge,
  type RemoteStatus,
  type StatusPayload,
} from "./forge";

const STATUS: StatusPayload = {
  state: "success",
  context: "ci::unit@x86_64-linux",
  description: "Succeeded (1s): .ci/x/y.log",
};

const STATUS_ROW: RemoteStatus = {
  context: STATUS.context,
  state: "success",
  description: STATUS.description,
};

const BRANCH_RULES = [
  {
    type: "required_status_checks",
    ruleset_id: 7,
    ruleset_source_type: "Repository",
    ruleset_source: "o/r",
  },
];

const RULESET = { id: 7, name: "main", target: "branch", enforcement: "active" };

const trash: string[] = [];
const GH_WAS = process.env.ODU_GH_BIN;

afterEach(() => {
  for (const dir of trash.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (GH_WAS === undefined) delete process.env.ODU_GH_BIN;
  else process.env.ODU_GH_BIN = GH_WAS;
});

/** Install a stand-in `gh` that answers every operation this contract names. */
function fakeGh(): void {
  const dir = mkdtempSync(join(tmpdir(), "odu-forge-gh-"));
  trash.push(dir);
  const at = (name: string): string => join(dir, name);
  writeFileSync(at("statuses.json"), JSON.stringify([STATUS_ROW]));
  writeFileSync(at("branch-rules.json"), JSON.stringify(BRANCH_RULES));
  writeFileSync(at("ruleset.json"), JSON.stringify(RULESET));
  writeFileSync(
    at("created.json"),
    JSON.stringify({ ...RULESET, id: 777 }),
  );
  const script = `#!/bin/sh
cat > /dev/null
printf '%s\\n' "$*" >> '${at("calls.txt")}'
case "$*" in
  *" -f state="*) printf '{}\\n' ;;
  *"page=1"*) cat '${at("statuses.json")}' ;;
  *"--jq .default_branch"*) printf 'master\\n' ;;
  *"/rules/branches/"*) cat '${at("branch-rules.json")}' ;;
  *"--method PUT"*) printf '{}' ;;
  *"--method POST"*) cat '${at("created.json")}' ;;
  *"/rulesets/"*) cat '${at("ruleset.json")}' ;;
  *) printf 'fake gh: unexpected call: %s\\n' "$*" >&2; exit 1 ;;
esac
`;
  const bin = at("gh");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  process.env.ODU_GH_BIN = bin;
}

/** A Forge held in memory — the second implementation the contract is stated
 *  against, and the shape a suite substitutes without a subprocess. */
function memoryForge(): Forge {
  const statuses = new Map<string, RemoteStatus>([[STATUS_ROW.context, STATUS_ROW]]);
  return {
    postStatus: async ({ payload }) => {
      statuses.set(payload.context, {
        context: payload.context,
        state: payload.state,
        description: payload.description,
      });
      return { ok: true };
    },
    listStatuses: async () => ({ ok: true, value: [...statuses.values()] }),
    defaultBranch: async () => ({ ok: true, value: "master" }),
    readRuleset: async (request) => ({
      ok: true,
      value: JSON.stringify(
        "branch" in request ? BRANCH_RULES : RULESET,
      ),
    }),
    writeRuleset: async (request) => ({
      ok: true,
      value: JSON.stringify(request.id === null ? { ...RULESET, id: 777 } : {}),
    }),
  };
}

/** Run the whole contract against one implementation. */
function contract(label: string, make: () => Forge): void {
  describe(`Forge contract: ${label}`, () => {
    it("posts a status and says it worked", async () => {
      expect(
        await make().postStatus({
          owner: "o",
          repo: "r",
          sha: "abc",
          payload: STATUS,
        }),
      ).toEqual({ ok: true });
    });

    it("lists a commit's statuses, newest first and one per context", async () => {
      const listed = await make().listStatuses({
        owner: "o",
        repo: "r",
        sha: "abc",
      });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value).toEqual([STATUS_ROW]);
    });

    it("reads the default branch", async () => {
      expect(await make().defaultBranch({ owner: "o", repo: "r" })).toEqual({
        ok: true,
        value: "master",
      });
    });

    it("reads the rules in force on a branch", async () => {
      const rules = await make().readRuleset({
        owner: "o",
        repo: "r",
        branch: "master",
      });
      expect(rules.ok).toBe(true);
      if (!rules.ok) return;
      expect(JSON.parse(rules.value) as unknown).toEqual(BRANCH_RULES);
    });

    it("reads one ruleset in full", async () => {
      const ruleset = await make().readRuleset({
        owner: "o",
        repo: "r",
        id: 7,
      });
      expect(ruleset.ok).toBe(true);
      if (!ruleset.ok) return;
      expect(JSON.parse(ruleset.value) as unknown).toEqual(RULESET);
    });

    it("creates a ruleset when no id is named", async () => {
      const made = await make().writeRuleset({
        owner: "o",
        repo: "r",
        id: null,
        body: "{}",
      });
      expect(made.ok).toBe(true);
      if (!made.ok) return;
      expect((JSON.parse(made.value) as { id: number }).id).toBe(777);
    });

    it("replaces a ruleset when an id is named", async () => {
      expect(
        await make().writeRuleset({
          owner: "o",
          repo: "r",
          id: 7,
          body: "{}",
        }),
      ).toEqual({ ok: true, value: "{}" });
    });
  });
}

contract("ghForge over $ODU_GH_BIN", () => {
  fakeGh();
  return ghForge();
});

contract("an in-memory fake", memoryForge);
