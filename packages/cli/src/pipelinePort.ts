/**
 * READING A CHECKOUT'S PIPELINE, for the service.
 *
 * `odu dump` and `odu graph` used to each call `loadJustPipeline` from the
 * process the operator typed in, which made them the only public commands whose
 * answer depended on the machine the terminal was on. Through this port the
 * DAEMON resolves the DAG, so a browser tab, an agent and a terminal are three
 * views of one answer rather than three ingestions that can disagree.
 *
 * The Mermaid rendering comes from the engine (`mermaidGraph`) rather than from
 * a face, for the reason `PipelineFacts.mermaid` gives: two renderers of one
 * graph is two graphs eventually.
 */

import { loadJustPipeline, mermaidGraph } from "@odu/execution/just/ingest";
import type { TaskSpec } from "@odu/execution/common/spec";
import type {
  PipelineOutcome,
  PipelineReader,
  TaskFacts,
} from "@odu/service/ports";

/**
 * `TaskSpec` → `TaskFacts`, spelled out rather than spread.
 *
 * The two are structurally the same set of fields deliberately (see the header
 * of `@odu/service/ports`), and writing the mapping by hand is what makes the
 * compiler prove it at the seam — a `{...task}` would carry the engine's future
 * additions onto the wire silently, including the coordinator-injected `env`
 * that is nobody's business outside a lane.
 *
 * Absent and empty stay distinct in the direction the port declares: `name` is
 * `null` when `just` gave the recipe none (the id IS its name), `os` is `[]`
 * because "runs everywhere" is knowledge, not ignorance, and `shards` is `null`
 * because an unsharded recipe has no maximum rather than a maximum of zero.
 */
function taskFacts(task: TaskSpec): TaskFacts {
  return {
    id: task.id,
    name: task.name ?? null,
    command: task.command,
    needs: task.needs,
    os: task.os ?? [],
    shards: task.shards ?? null,
  };
}

/**
 * Resolve the `[metadata("ci")]` DAG in a checkout.
 *
 * Every failure below — no justfile, a `just` too old to name module deps, a
 * cycle, an unknown `--root` — arrives as `{ ok: false }` carrying the ENGINE's
 * own sentence. It names the recipe that is wrong and this layer does not, and
 * a face that replaced it with "could not read the pipeline" would be throwing
 * away the only part of the message an operator can act on.
 */
export const readPipeline: PipelineReader = (request): PipelineOutcome => {
  try {
    const spec = loadJustPipeline(request.checkout, {
      // ABSENT, not `undefined`: `IngestOptions.root` distinguishes "the caller
      // named a root" from "discover the unique ci-tagged recipe", and an
      // explicit `undefined` key is the former in a shape that reads as the
      // latter.
      ...(request.root === undefined ? {} : { root: request.root }),
    });
    return {
      ok: true,
      facts: {
        name: spec.name,
        tasks: spec.tasks.map(taskFacts),
        mermaid: mermaidGraph(spec),
      },
    };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
};
