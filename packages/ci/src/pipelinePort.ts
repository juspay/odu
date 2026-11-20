import { loadJustPipeline, mermaidGraph } from "@odu/execution/just/ingest";
import type { TaskSpec } from "@odu/execution/common/spec";
import type {
  PipelineOutcome,
  PipelineReader,
  TaskFacts,
} from "@odu/service/ports";

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

export const readPipeline: PipelineReader = (request): PipelineOutcome => {
  try {
    const spec = loadJustPipeline(request.checkout, {
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
