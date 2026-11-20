import type { NodeStatus, PipelineState } from "@odu/run-client/surface";
import type { NodePatch } from "../common/nodePatch";
import { NON_TERMINAL_STATUSES } from "../common/verdict";

export interface PublishedState {
  readonly state: PipelineState;
}

export interface VerdictGateDeps {
  isLogEnded: (id: string) => boolean;
  publishedStatus: (id: string) => NodeStatus | undefined;
  nodeIds: () => readonly string[];
  write: (id: string, patch: NodePatch) => void;
  drainLogs: () => Promise<void>;
  snapshot: () => PipelineState;
}

export interface VerdictGate {
  offer: (id: string, patch: NodePatch) => void;
  release: (id: string) => void;
  releaseAll: (of?: (id: string) => boolean) => void;
  boundIfOnlyLogsOutstanding: () => void;
  publishedSnapshot: (of?: (id: string) => boolean) => PublishedState;
}

const isTerminal = (status: NodeStatus | undefined): boolean =>
  status !== undefined && !NON_TERMINAL_STATUSES.has(status);

export function createVerdictGate(deps: VerdictGateDeps): VerdictGate {
  const held = new Map<string, NodePatch>();

  const release = (id: string): void => {
    const patch = held.get(id);
    if (patch === undefined) return;
    held.delete(id);
    deps.write(id, patch);
  };

  const releaseAll = (of: (id: string) => boolean = () => true): void => {
    for (const id of [...held.keys()]) {
      if (of(id)) release(id);
    }
  };

  const onlyLogsOutstanding = (): boolean =>
    held.size > 0 &&
    deps.nodeIds().every((id) => held.has(id) || isTerminal(deps.publishedStatus(id)));

  let bounding = false;
  const boundIfOnlyLogsOutstanding = (): void => {
    if (bounding || !onlyLogsOutstanding()) return;
    bounding = true;
    void (async () => {
      try {
        await deps.drainLogs();
      } finally {
        bounding = false;
        releaseAll();
      }
    })();
  };

  return {
    offer: (id, patch) => {
      const status = patch.status;
      if (status === undefined) {
        deps.write(id, patch);
        return;
      }
      if (!isTerminal(status)) {
        held.delete(id);
        deps.write(id, patch);
        return;
      }
      if (isTerminal(deps.publishedStatus(id)) || deps.isLogEnded(id)) {
        deps.write(id, patch);
        return;
      }
      held.set(id, patch);
      boundIfOnlyLogsOutstanding();
    },
    release,
    releaseAll,
    boundIfOnlyLogsOutstanding,
    publishedSnapshot: (of) => {
      releaseAll(of);
      return { state: deps.snapshot() };
    },
  };
}
