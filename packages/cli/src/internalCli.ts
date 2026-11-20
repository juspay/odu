import { parseArgs } from "node:util";
import { runCommand } from "@odu/execution/coordinator/run";
import { leaseHoldCommand } from "./leaseCmd";
import { cliRunFace, faceEnv } from "./runFace";

export const INTERNAL_COMMANDS = ["run-coordinator", "lease-hold"] as const;

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
      actor: { type: "string" },
      push: { type: "string" },
      "push-origin": { type: "string" },
      "push-bucket": { type: "string" },
      "push-token-id": { type: "string" },
      "push-skipped": { type: "string" },
      "push-key-warning": { type: "string" },
      "checkout-moved": { type: "string" },
    },
  });
  if (values.progress !== undefined && values.progress !== "json") {
    throw new Error(`odu: unknown --progress format "${values.progress}"`);
  }
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
      ...(values.actor === undefined ? {} : { actor: values.actor }),
      ...(values.push === undefined ||
      values["push-origin"] === undefined ||
      values["push-bucket"] === undefined ||
      values["push-token-id"] === undefined
        ? {}
        : {
            push: {
              substituter: values.push,
              origin: values["push-origin"],
              bucket: values["push-bucket"],
              tokenId: values["push-token-id"],
            },
          }),
      ...(values["push-skipped"] === undefined
        ? {}
        : { pushSkipped: values["push-skipped"] }),
      ...(values["push-key-warning"] === undefined
        ? {}
        : { pushKeyWarning: values["push-key-warning"] }),
      ...(values["checkout-moved"] === undefined
        ? {}
        : { checkoutMoved: values["checkout-moved"] }),
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
