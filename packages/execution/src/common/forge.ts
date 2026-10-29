/**
 * THE FORGE — the one place odu speaks to GitHub.
 *
 * Two processes need GitHub, and neither may learn the other's argv:
 *
 *   - the **coordinator** posts commit statuses on every transition
 *     (`coordinator/statuses.ts`), and
 *   - the **service** reads and writes a branch's ruleset on `protect.apply`
 *     (`@odu/cli`'s protect port).
 *
 * Each used to carry a private `gh()` over the `$ODU_GH_BIN` seam. That is two
 * spellings of one credential decision, and the next one — an installation
 * token from a different identity — would have had to be threaded through both.
 * The operations are named here in GitHub's vocabulary instead, and
 * {@link ghForge} is the one implementation: the user's `gh`, behind the
 * `$ODU_GH_BIN` override the e2e suites fake. It lives in the engine because the
 * coordinator is a separately spawned process and cannot be handed a function
 * by the daemon; the service root binds the same implementation for protect.
 *
 * **Reads return RAW JSON TEXT, and that is deliberate.** The wire shapes of a
 * ruleset are volatile (a rule's `parameters` is an opaque bag that must survive
 * a read-modify-write byte-for-byte), and their schemas live with the policy
 * that reads them, in `@odu/cli`'s `rulesets.ts`. Moving them here would put a
 * face's policy in the engine. The forge's job is to make the call and say what
 * came back; deciding what the answer means belongs to the caller.
 *
 * `postStatus`/`listStatuses` do decode, because their shapes are the
 * coordinator's own contract with GitHub and nothing above the engine reads
 * them.
 */

import { spawn } from "node:child_process";
import type { GithubState } from "@odu/run-client/surface";

/** Kill a hung `gh` so it can neither wedge the serialized status queue nor
 *  leave a protect call waiting on a TCP connection forever. */
export const DEFAULT_GH_TIMEOUT_MS = 30_000;

/** What GitHub is told about one context. */
export interface StatusPayload {
  state: GithubState;
  context: string;
  description: string;
}

/** One remote status as returned by GET …/commits/{sha}/status. */
export interface RemoteStatus {
  context: string;
  state: string;
  description: string;
}

/** A call that has no answer beyond whether it worked. */
export type ForgeResult = { ok: true } | { ok: false; error: string };

/** A call whose answer is a value — `error` is the forge's own sentence, never
 *  a throw, so a caller can turn it into its own refusal. */
export type ForgeOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** The repository every operation is addressed within. */
export interface ForgeRepo {
  readonly owner: string;
  readonly repo: string;
}

/** Which ruleset read is meant: the rules in force on a branch, or one ruleset
 *  in full. Both are `readRuleset` because both are GitHub's read of the same
 *  policy object, and a second method would be two names for one verb. */
export type RulesetRef =
  | { readonly branch: string }
  | { readonly id: number };

/**
 * WHAT ODU NEEDS FROM A FORGE, and no more.
 *
 * The five methods are the five calls the two call sites actually make. A sixth
 * arrives when a caller does, not because a hypothetical forge might offer one.
 */
export interface Forge {
  /** Post one commit status. */
  postStatus(
    request: ForgeRepo & { sha: string; payload: StatusPayload },
  ): Promise<ForgeResult>;
  /** Every status a commit carries, newest first, one per context. */
  listStatuses(
    request: ForgeRepo & { sha: string },
  ): Promise<ForgeOutcome<readonly RemoteStatus[]>>;
  /** The repository's default branch. */
  defaultBranch(request: ForgeRepo): Promise<ForgeOutcome<string>>;
  /** The raw JSON of a branch's rules or of one ruleset. */
  readRuleset(
    request: ForgeRepo & RulesetRef,
  ): Promise<ForgeOutcome<string>>;
  /** Create a ruleset (`id: null`) or replace one (`id` present); the raw JSON
   *  of the created ruleset on a create, and the call's own body otherwise. */
  writeRuleset(
    request: ForgeRepo & { id: number | null; body: string },
  ): Promise<ForgeOutcome<string>>;
}

/** The forge every odu process gets today: the user's `gh`. */
export function ghForge(): Forge {
  return {
    postStatus: (request) =>
      runGh(
        [
          "api",
          `${repoArg(request)}/statuses/${request.sha}`,
          "-f",
          `state=${request.payload.state}`,
          "-f",
          `context=${request.payload.context}`,
          "-f",
          `description=${request.payload.description}`,
        ],
        { captureStdout: false },
      ).then((result) => (result.ok ? { ok: true } : result)),

    listStatuses: async (request) => {
      const out: RemoteStatus[] = [];
      const seen = new Set<string>();
      // Bound pages so a pathological history cannot hang seed forever.
      const maxPages = 50;
      for (let page = 1; page <= maxPages; page++) {
        const result = await runGh(
          [
            "api",
            `${repoArg(request)}/statuses/${request.sha}?per_page=100&page=${page}`,
          ],
          { captureStdout: true },
        );
        if (!result.ok) return { ok: false, error: result.error };
        const trimmed = result.stdout.trim();
        if (trimmed === "") break;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return {
            ok: false,
            error: "gh answered something that is not JSON",
          };
        }
        if (!Array.isArray(parsed) || parsed.length === 0) break;
        for (const item of parsed) {
          const row = remoteStatusFromItem(item);
          if (row === null || seen.has(row.context)) continue;
          seen.add(row.context);
          out.push(row);
        }
        if (parsed.length < 100) break;
      }
      return { ok: true, value: out };
    },

    defaultBranch: async (request) => {
      const result = await runGh(
        ["api", repoArg(request), "--jq", ".default_branch"],
        { captureStdout: true },
      );
      return result.ok
        ? { ok: true, value: result.stdout.trim() }
        : { ok: false, error: result.error };
    },

    readRuleset: async (request) => {
      const path =
        "branch" in request
          ? `${repoArg(request)}/rules/branches/${request.branch}`
          : `${repoArg(request)}/rulesets/${request.id}`;
      const result = await runGh(["api", path], { captureStdout: true });
      return result.ok
        ? { ok: true, value: result.stdout }
        : { ok: false, error: result.error };
    },

    writeRuleset: async (request) => {
      const result = await runGh(
        request.id === null
          ? ["api", "--method", "POST", `${repoArg(request)}/rulesets`, "--input", "-"]
          : [
              "api",
              "--method",
              "PUT",
              `${repoArg(request)}/rulesets/${request.id}`,
              "--input",
              "-",
            ],
        { captureStdout: true, input: request.body },
      );
      return result.ok
        ? { ok: true, value: result.stdout }
        : { ok: false, error: result.error };
    },
  };
}

function repoArg(request: ForgeRepo): string {
  return `repos/${request.owner}/${request.repo}`;
}

type GhRunResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string };

/** Spawn `gh` with kill-on-timeout. Every forge call goes through here, which is
 *  what keeps `$ODU_GH_BIN` the one seam — read at CALL time so a suite that
 *  swaps the binary between two calls is not looking at a captured value. */
function runGh(
  args: string[],
  opts: { captureStdout: boolean; input?: string },
): Promise<GhRunResult> {
  const gh = process.env.ODU_GH_BIN ?? "gh";
  return new Promise((resolve) => {
    const child = spawn(gh, args, {
      stdio: [
        opts.input === undefined ? "ignore" : "pipe",
        opts.captureStdout ? "pipe" : "ignore",
        "pipe",
      ],
    });
    if (opts.input !== undefined) {
      child.stdin?.end(opts.input);
    }
    let stdout = "";
    let stderr = "";
    if (opts.captureStdout) {
      child.stdout?.on("data", (c: Buffer) => {
        stdout += c.toString("utf-8");
      });
    }
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf-8");
    });
    let settled = false;
    const done = (result: GhRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ ok: false, error: `gh timed out after ${DEFAULT_GH_TIMEOUT_MS}ms` });
    }, DEFAULT_GH_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", (err) => done({ ok: false, error: err.message }));
    child.on("close", (code) => {
      if (code === 0) done({ ok: true, stdout });
      else done({ ok: false, error: stderr.trim() || `gh exited ${code}` });
    });
  });
}

function remoteStatusFromItem(item: unknown): RemoteStatus | null {
  if (typeof item !== "object" || item === null) return null;
  const row = item as Record<string, unknown>;
  const context = typeof row.context === "string" ? row.context : "";
  const state = typeof row.state === "string" ? row.state : "";
  const description =
    typeof row.description === "string" ? row.description : "";
  if (context === "") return null;
  return { context, state, description };
}
