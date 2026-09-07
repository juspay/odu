/**
 * `odu dump` · `odu graph` · `odu protect` — a checkout's recipes, as clients.
 *
 * These three looked like the safe exceptions. `dump` and `graph` read a
 * justfile and touch no run; `protect` writes a GitHub ruleset and spends the
 * caller's own `gh` credential. Both defences were wrong, and in different
 * ways.
 *
 * **Reading a justfile is not "no authority", it is a SECOND RESOLVER.** What
 * odu will run for a given checkout is a question the service has to answer
 * anyway — `run.start` resolves the same DAG through the same engine — so a
 * face that answered it locally was a second implementation of the one thing a
 * person most needs to be able to trust: `odu graph` and the run it is meant to
 * predict could disagree, and nothing would notice. It also meant the browser
 * could not draw a pipeline at all and an agent could not ask what a repository
 * even builds.
 *
 * **The `protect` defence was factually false.** "The daemon must not spend
 * your credential" describes an odu that does not exist: the coordinator the
 * daemon launches has posted commit statuses with that same credential since
 * long before this, and `--no-post` is the opt-out. Keeping `protect` local on
 * that ground preserved nothing and cost the other two faces the capability
 * entirely.
 */

import type { Pipeline, ProtectOutput, TaskRow } from "@odu/service-client/surface";
import {
  call,
  checkoutHere,
  emitJson,
  reportFailure,
  requestId,
  withService,
} from "./serviceFace";

export interface PipelineOpts {
  /** `dump` is the resolved spec as JSON; `graph` is the same DAG as Mermaid. */
  as: "dump" | "graph";
  root?: string;
  origin?: string;
  cwd?: string;
}

/**
 * `odu dump` / `odu graph` — the pipeline this checkout declares.
 *
 * Two spellings of one read, which is why they are one function: the SERVICE
 * renders the Mermaid, so `odu graph` and a browser drawing the same pipeline
 * cannot be two renderers that drift apart.
 */
export async function pipelineViaService(opts: PipelineOpts): Promise<number> {
  const checkout = checkoutHere(opts.cwd);
  return withService(opts.origin, async (client) => {
    const read = await call(
      client.surface.pipeline.read({
        checkout,
        ...(opts.root === undefined ? {} : { root: opts.root }),
      }),
    );
    // `dump` has no non-JSON rendering — its whole output IS the JSON — so a
    // refusal here reports as prose on stderr either way.
    if (!read.ok) return reportFailure(read, false);
    const pipeline: Pipeline = read.value;
    if (opts.as === "graph") {
      process.stdout.write(pipeline.mermaid);
      return 0;
    }
    emitJson(dumpShape(pipeline));
    return 0;
  });
}

/** The shape `odu dump` has always printed: the pipeline's name and its tasks.
 *  Spelled here rather than dumping the wire payload verbatim, because
 *  `checkout` and `mermaid` are answers to different questions and a consumer
 *  parsing this file's output should not have to skip past them. */
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

/**
 * `odu protect` — require exactly the status checks odu posts.
 *
 * `--dry-run` prints the contexts and writes nothing, which is the honest first
 * move: the contexts are derived from the repository's recipes crossed with a
 * platform set, and a person should see that list before it becomes a rule that
 * blocks merges.
 */
export async function protectViaService(opts: ProtectOpts): Promise<number> {
  const checkout = checkoutHere(opts.cwd);
  return withService(opts.origin, async (client) => {
    const done = await call(
      client.surface.protect.apply({
        checkout,
        ...(opts.branch === undefined ? {} : { branch: opts.branch }),
        platforms: opts.platforms,
        dryRun: opts.dryRun,
        create: opts.create,
        requestId: requestId(undefined),
      }),
    );
    if (!done.ok) return reportFailure(done, opts.json);
    const answer: ProtectOutput = done.value;
    if (opts.json) {
      emitJson(answer);
      return 0;
    }
    // A DERIVED platform set is a machine-local fact standing in for a repo
    // one — the hosts file on THIS laptop deciding what a repository requires
    // of everybody. It is allowed, and it is said out loud every time.
    if (answer.derivedFrom !== null) {
      process.stderr.write(
        `odu: protect derived the platform set from ${answer.derivedFrom} — a\n` +
          "     machine-local hosts config, not a repo fact; pass --platform to\n" +
          "     pin the repo's platform set explicitly\n",
      );
    }
    if (answer.dryRun) {
      // The contexts and nothing else. A dry run is the "what would this
      // require" move, and it deliberately does not consult the forge — so
      // there is no repo or branch to print, and printing a guess would be
      // worse than printing neither.
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
