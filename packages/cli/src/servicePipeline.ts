import type { Pipeline, ProtectOutput, TaskRow } from "@odu/service-client/surface";
import {
  hostsFileHere,
  call,
  checkoutHere,
  emitJson,
  reportFailure,
  requestId,
  withService,
} from "./serviceFace";

export interface PipelineOpts {
  as: "dump" | "graph";
  root?: string;
  origin?: string;
  cwd?: string;
}

export async function pipelineViaService(opts: PipelineOpts): Promise<number> {
  const checkout = checkoutHere(opts.cwd);
  return withService(opts.origin, async (client) => {
    const read = await call(
      client.surface.pipeline.read({
        checkout,
        ...(opts.root === undefined ? {} : { root: opts.root }),
      }),
    );
    if (!read.ok) return reportFailure(read, false, 1);
    const pipeline: Pipeline = read.value;
    if (opts.as === "graph") {
      process.stdout.write(pipeline.mermaid);
      return 0;
    }
    emitJson(dumpShape(pipeline));
    return 0;
  });
}

function dumpShape(pipeline: Pipeline): {
  name: string;
  tasks: readonly TaskRow[];
} {
  return { name: pipeline.name, tasks: pipeline.tasks };
}

export interface ProtectOpts {
  dryRun: boolean;
  branch?: string;
  platforms: readonly string[];
  create: boolean;
  json: boolean;
  origin?: string;
  cwd?: string;
}

export async function protectViaService(opts: ProtectOpts): Promise<number> {
  const checkout = checkoutHere(opts.cwd);
  return withService(opts.origin, async (client) => {
    const done = await call(
      client.surface.protect.apply({
        checkout,
        ...(opts.branch === undefined ? {} : { branch: opts.branch }),
        platforms: opts.platforms,
        hostsFile: hostsFileHere(opts.cwd),
        dryRun: opts.dryRun,
        create: opts.create,
        requestId: requestId(undefined),
      }),
    );
    if (!done.ok) return reportFailure(done, opts.json, 1);
    const answer: ProtectOutput = done.value;
    if (opts.json) {
      emitJson(answer);
      return 0;
    }
    if (answer.derivedFrom !== null) {
      const derived = [
        ...new Set(
          answer.contexts.map((c) => c.slice(c.lastIndexOf("@") + 1)),
        ),
      ].join(", ");
      process.stderr.write(
        `odu: protect: platform set (${derived}) derives from\n` +
          `     ${answer.derivedFrom} — a machine-local hosts config, not a repo\n` +
          "     fact; pass --platform to pin the repo's platform set explicitly\n",
      );
    }
    if (answer.dryRun) {
      for (const context of answer.contexts) process.stdout.write(`${context}\n`);
      return 0;
    }
    process.stdout.write(
      `${answer.repo}@${answer.branch}: ${answer.contexts.length} required ` +
        `check${answer.contexts.length === 1 ? "" : "s"}` +
        `${answer.created ? " (ruleset created)" : ""}\n`,
    );
    if (answer.detail !== null) process.stdout.write(`${answer.detail}\n`);
    return 0;
  });
}
