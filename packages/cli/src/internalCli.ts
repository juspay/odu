/**
 * THE WORKERS — argv entry points nothing public dispatches to.
 *
 * `run-coordinator` IS the coordinator, and `lease-hold` IS the detached
 * process that holds a venue. Neither is a command a person types; both are
 * spelled as argv because a launcher has to be able to SHOW what it would run —
 * "here is exactly the process I am about to start" is a list somebody can read
 * and re-issue, and never a string anything evals.
 *
 * **They are here, and not in `src/main.ts`, because of the import wall.**
 * `./authority.test.ts` derives the set of public client modules from what
 * `src/main.ts` imports and then proves none of them can reach the engine, the
 * catalog store or a coordinator dial. While these two dispatch bodies lived in
 * `main.ts`, that file imported `@odu/execution/coordinator/run` directly — so
 * the derivation had to begin by excusing its own root, which is the kind of
 * exception that makes a wall decorative. Moved out, `main.ts`'s import list is
 * `@odu/cli/*` and a version string, and every entry in it is classified on
 * purpose.
 *
 * The other reason is the recursion trap, and it is worth stating because it is
 * not obvious: while the coordinator and the public verb were both spelled
 * `run`, making `odu run` a service client would have meant
 * `run.start → launcher → odu run → run.start`, forever. The launcher types
 * `run-coordinator`; a person types `run`.
 *
 * `--run-id` in particular lets its caller mint a run identity the catalog will
 * accept, which is authority no public command may hold. That is the sharpest
 * reason these four identity flags live here and nowhere else.
 */

import { parseArgs } from "node:util";
import { runCommand } from "@odu/execution/coordinator/run";
import { leaseHoldCommand } from "./leaseCmd";
import { cliRunFace, faceEnv } from "./runFace";

/** The worker verbs, named once so the dispatcher and the test that asserts
 *  they are absent from the public usage text read the same list. */
export const INTERNAL_COMMANDS = ["run-coordinator", "lease-hold"] as const;

/**
 * Dispatch a worker verb, or answer `null` for anything else.
 *
 * `null` rather than a thrown "unknown command", so the public dispatcher stays
 * the one place that decides what an unrecognised word means — there is exactly
 * one usage message and exactly one exit code for a typo.
 */
export function internalCommand(
  command: string | undefined,
  rest: string[],
): Promise<number> | null {
  switch (command) {
    case "run-coordinator":
      return runCoordinator(rest);
    case "lease-hold":
      return leaseHold(rest);
    default:
      return null;
  }
}

async function runCoordinator(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      platform: { type: "string", multiple: true },
      host: { type: "string", multiple: true },
      root: { type: "string" },
      "no-deps": { type: "boolean" },
      "no-strict": { type: "boolean" },
      "no-snapshot": { type: "boolean" },
      "no-post": { type: "boolean" },
      progress: { type: "string" },
      supersede: { type: "boolean" },
      linger: { type: "boolean" },
      "no-wait": { type: "boolean" },
      "expected-sha": { type: "string" },
      "run-id": { type: "string" },
      "parent-run": { type: "string" },
      "request-id": { type: "string" },
    },
  });
  if (values.progress !== undefined && values.progress !== "json") {
    throw new Error(`odu: unknown --progress format "${values.progress}"`);
  }
  // THE FACE IS SUPPLIED HERE, and only here. The coordinator's default is
  // silence — see `RunDeps.face` — so a terminal matrix, an NDJSON stream and a
  // piped transition log are all this command's decision, not the engine's.
  return runCommand(
    {
      selectors: positionals,
      platforms: values.platform ?? [],
      hostPins: values.host ?? [],
      root: values.root,
      noDeps: values["no-deps"] ?? false,
      noStrict: values["no-strict"] ?? false,
      noSnapshot: values["no-snapshot"] ?? false,
      noPost: values["no-post"] ?? false,
      supersede: values.supersede ?? false,
      linger: values.linger ?? false,
      noWait: values["no-wait"] ?? false,
      ...(values["expected-sha"] === undefined
        ? {}
        : { expectedSha: values["expected-sha"] }),
      ...(values["run-id"] === undefined ? {} : { runId: values["run-id"] }),
      ...(values["parent-run"] === undefined
        ? {}
        : { parentRunId: values["parent-run"] }),
      ...(values["request-id"] === undefined
        ? {}
        : { requestId: values["request-id"] }),
    },
    {
      face: cliRunFace({
        ...faceEnv(),
        progressJson: values.progress === "json",
      }),
    },
  );
}

async function leaseHold(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: {
      platform: { type: "string" },
      repo: { type: "string" },
      "no-wait": { type: "boolean" },
    },
  });
  if (values.platform === undefined || values.platform === "") {
    throw new Error("odu lease-hold: --platform is required");
  }
  return leaseHoldCommand({
    platform: values.platform,
    noWait: values["no-wait"] ?? false,
    repoRoot: values.repo ?? process.cwd(),
  });
}
