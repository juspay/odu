import { Effect, Schema } from "effect";
import { NodeIdSchema } from "@odu/run-client/nodeId";

export const TaskSpecSchema = Schema.Struct({
  id: NodeIdSchema,
  /** Display name; defaults to the id. */
  name: Schema.optionalKey(Schema.String),
  /** Shell command, run via `sh -c` from the workspace root. */
  command: Schema.String.check(Schema.isMinLength(1)),
  needs: Schema.Array(NodeIdSchema).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed<readonly string[]>([])),
  ),
  /** `just` OS-family attributes restricting which platforms schedule this
   *  recipe; absent / empty ⇒ every platform. */
  os: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Maximum number of execution slots this recipe may burst across. */
  shards: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(1)),
  ),
  /** The git REFS whose runs pin this recipe's pushed closure, with `null`
   *  meaning the repository's default branch. Absent for a recipe whose output
   *  nothing holds open. */
  pin: Schema.optionalKey(
    Schema.Array(Schema.NullOr(Schema.String)).check(Schema.isMinLength(1)),
  ),
  /** Coordinator-injected task environment. */
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Where the recipe runs, relative to the workspace root — absent when that
   *  IS the workspace root, absolute when `set working-directory` took it out
   *  of the workspace. */
  workdir: Schema.optionalKey(Schema.String),
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
 *  the `needs` graph is acyclic. */
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
