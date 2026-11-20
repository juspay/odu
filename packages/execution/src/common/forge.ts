/**
 * The one place odu speaks to GitHub. Reads return RAW JSON TEXT: a ruleset's
 * `parameters` is an opaque bag that must survive a read-modify-write
 * byte-for-byte. `postStatus`/`listStatuses` do decode.
 */

import { spawn } from "node:child_process";
import type { GithubState } from "@odu/run-client/surface";

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
 *  a throw. */
export type ForgeOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/** The repository every operation is addressed within. */
export interface ForgeRepo {
  readonly owner: string;
  readonly repo: string;
}

/** Which ruleset read is meant: the rules in force on a branch, or one ruleset
 *  in full. */
export type RulesetRef =
  | { readonly branch: string }
  | { readonly id: number };

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
  /** Create a ruleset, answering its raw JSON. */
  createRuleset(
    request: ForgeRepo & { body: string },
  ): Promise<ForgeOutcome<string>>;
  /** Replace a ruleset wholesale. */
  replaceRuleset(
    request: ForgeRepo & { id: number; body: string },
  ): Promise<ForgeResult>;
}

/** The forge every odu process gets today: the user's `gh`. `timeoutMs` kills
 *  the child. */
export function ghForge(opts: { timeoutMs?: number } = {}): Forge {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;
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
        { captureStdout: false, timeoutMs },
      ).then((result) => (result.ok ? { ok: true } : result)),

    listStatuses: async (request) => {
      const out: RemoteStatus[] = [];
      const seen = new Set<string>();
      const maxPages = 50;
      for (let page = 1; page <= maxPages; page++) {
        const result = await runGh(
          [
            "api",
            `${repoArg(request)}/statuses/${request.sha}?per_page=100&page=${page}`,
          ],
          { captureStdout: true, timeoutMs },
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
        { captureStdout: true, timeoutMs },
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
      const result = await runGh(["api", path], { captureStdout: true, timeoutMs });
      return result.ok
        ? { ok: true, value: result.stdout }
        : { ok: false, error: result.error };
    },

    createRuleset: async (request) => {
      const result = await runGh(
        ["api", "--method", "POST", `${repoArg(request)}/rulesets`, "--input", "-"],
        { captureStdout: true, input: request.body, timeoutMs },
      );
      return result.ok
        ? { ok: true, value: result.stdout }
        : { ok: false, error: result.error };
    },

    replaceRuleset: (request) =>
      runGh(
        [
          "api",
          "--method",
          "PUT",
          `${repoArg(request)}/rulesets/${request.id}`,
          "--input",
          "-",
        ],
        { captureStdout: false, input: request.body, timeoutMs },
      ).then((result) => (result.ok ? { ok: true } : result)),
  };
}

function repoArg(request: ForgeRepo): string {
  return `repos/${request.owner}/${request.repo}`;
}

type GhRunResult =
  | { ok: true; stdout: string }
  | { ok: false; error: string };

function runGh(
  args: string[],
  opts: { captureStdout: boolean; input?: string; timeoutMs: number },
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
      done({ ok: false, error: `gh timed out after ${opts.timeoutMs}ms` });
    }, opts.timeoutMs);
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
