import type { NodeState, NodeStatus } from "@odu/run-client/surface";
import { NON_TERMINAL_STATUSES } from "../common/verdict";

export interface VerdictGateDeps {
  isLogEnded: (id: string) => boolean;
  publishedStatus: (id: string) => NodeStatus | undefined;
  nodeIds: () => readonly string[];
  publish: (id: string, patch: Partial<NodeState>) => void;
  drainLogs: () => Promise<void>;
}

export interface VerdictGate {
  offer: (id: string, patch: Partial<NodeState>) => void;
  release: (id: string) => void;
  releaseAll: (of?: (id: string) => boolean) => void;
  boundIfOnlyLogsOutstanding: () => void;
}

const isTerminal = (status: NodeStatus | undefined): boolean =>
  status !== undefined && !NON_TERMINAL_STATUSES.has(status);

export function createVerdictGate(deps: VerdictGateDeps): VerdictGate {
  const held = new Map<string, Partial<NodeState>>();

  const release = (id: string): void => {
    const patch = held.get(id);
    if (patch === undefined) return;
    held.delete(id);
    deps.publish(id, patch);
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
      if (!isTerminal(status)) {
        held.delete(id);
        deps.publish(id, patch);
        return;
      }
      if (isTerminal(deps.publishedStatus(id)) || deps.isLogEnded(id)) {
        deps.publish(id, patch);
        return;
      }
      held.set(id, patch);
      boundIfOnlyLogsOutstanding();
    },
    release,
    releaseAll,
    boundIfOnlyLogsOutstanding,
  };
}
