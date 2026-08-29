/**
 * The pipeline spec — the wire shape `run.configure` carries to a lane
 * runner, and the in-memory shape the coordinator derives from the `just`
 * DAG (src/just/ingest.ts).
 *
 * Task ids are `just` namepaths (`ci::e2e`); the synthetic `_ci-setup` node
 * the runner prepends (src/runner/runner.ts) is the one non-namepath id,
 * mirroring justci's `_ci-setup@<platform>` bookkeeping context.
 */

import { Effect, Schema } from "effect";
import { NodeIdSchema } from "@odu/run-client/nodeId";

/** The zod→Effect mapping is LAW here (kolu PLAN #17), and both idioms in this
 *  file are wire-bearing — `TaskSpecSchema` is embedded in `ConfigureInput`,
 *  which crosses the stdio wire to `odu-runner`:
 *
 *    - `.optional()` → `Schema.optionalKey`, never `Schema.optional`. Absent
 *      means ABSENT on this wire; `optional` would round-trip an explicit
 *      `undefined` through `null`.
 *    - `.default(v)` → `Schema.withDecodingDefaultKey`. STRICTER than zod on an
 *      in-memory `undefined`: zod's `.default([])` accepted `{needs: undefined}`
 *      and substituted; this rejects it. Every in-process producer must OMIT the
 *      key rather than spell it `undefined` (`just/ingest.ts` builds `needs` and
 *      `os` totally, which is why nothing here needs a conditional spread). */
export const TaskSpecSchema = Schema.Struct({
  id: NodeIdSchema,
  /** Display name; defaults to the id. */
  name: Schema.optionalKey(Schema.String),
  /** Shell command, run via `sh -c` from the workspace root. */
  command: Schema.String.check(Schema.isMinLength(1)),
  needs: Schema.Array(NodeIdSchema).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed<readonly string[]>([])),
  ),
  /** `just` OS-family attributes (`[linux]` / `[macos]` / `[unix]` / …) that
   *  restrict which platforms schedule this recipe; absent / empty ⇒ every
   *  platform. Consumed coordinator-side at fan-out (src/just/ingest.ts
   *  `laneTasks`); the runner ignores it, since a task only ever reaches a lane
   *  it's enabled on. */
  os: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type TaskSpec = typeof TaskSpecSchema.Type;

export const PipelineSpecSchema = Schema.Struct({
  name: Schema.String.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("pipeline")),
  ),
  tasks: Schema.Array(TaskSpecSchema).check(Schema.isMinLength(1)),
});
export type PipelineSpec = typeof PipelineSpecSchema.Type;

/** Throws unless every dependency names a declared task, ids are unique, and
 *  the `needs` graph is acyclic (Kahn's algorithm as a cycle check: if not
 *  every node drains, a cycle remains). */
export function validatePipeline(spec: PipelineSpec): PipelineSpec {
  const ids = new Set<string>();
  for (const task of spec.tasks) {
    if (ids.has(task.id)) {
      throw new Error(`pipeline: duplicate task id "${task.id}"`);
    }
    ids.add(task.id);
  }
  for (const task of spec.tasks) {
    for (const dep of task.needs) {
      if (!ids.has(dep)) {
        throw new Error(
          `pipeline: task "${task.id}" needs unknown task "${dep}"`,
        );
      }
    }
  }
  assertAcyclic(spec.tasks);
  return spec;
}

function assertAcyclic(tasks: readonly TaskSpec[]): void {
  const remainingDeps = new Map<string, Set<string>>(
    tasks.map((t) => [t.id, new Set(t.needs)]),
  );
  const queue = tasks.filter((t) => t.needs.length === 0).map((t) => t.id);
  let drained = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    drained += 1;
    for (const [candidate, deps] of remainingDeps) {
      if (deps.delete(id) && deps.size === 0) queue.push(candidate);
    }
  }
  if (drained !== tasks.length) {
    throw new Error("pipeline: dependency cycle detected");
  }
}
