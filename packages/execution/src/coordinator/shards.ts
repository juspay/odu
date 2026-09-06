/**
 * Shard topology, independent of venue acquisition and lane transport.
 *
 * A framework shard count is immutable once a lane is configured. This module
 * describes the resulting DAG and node projection after capacity has already
 * been chosen; it neither leases machines nor starts them.
 */

import { fanId, SETUP_NAMEPATH } from "@odu/run-client/nodeId";
import {
  type NodeState,
  type NodeStatus,
  pendingNode,
  type PipelineState,
} from "@odu/run-client/surface";
import type { TaskSpec } from "../common/spec";

const SETUP = SETUP_NAMEPATH;

export interface ShardTopology {
  rootId: string;
  /** The root and its transitive prerequisites, in runner order. */
  tasks: TaskSpec[];
  total: number;
}

export interface ShardCapacityRequest {
  rootId: string;
  /** Optional workers only; every root also uses the primary lane. */
  limit: number;
}

/**
 * Let independent shard roots reuse a platform's optional workers.
 *
 * The lease belongs to the run, not to one recipe. Each root therefore takes a
 * prefix up to its own ceiling; one worker may appear in several roots and its
 * lease stays held until every lane using it settles.
 */
export function shareShardCapacity<T>(
  requests: readonly ShardCapacityRequest[],
  workers: readonly T[],
): ReadonlyMap<string, T[]> {
  return new Map(
    requests.map(({ rootId, limit }) => [
      rootId,
      workers.slice(0, Math.max(0, limit)),
    ]),
  );
}

export function shardNamepath(
  namepath: string,
  index: number,
  total: number,
): string {
  return `${namepath}[${index + 1}-of-${total}]`;
}

/** Public name for one node in a shard lane's private dependency closure. */
export function shardLaneNamepath(
  root: string,
  index: number,
  total: number,
  laneNode: string,
): string {
  const shard = shardNamepath(root, index, total);
  return laneNode === root ? shard : `${shard}::${laneNode}`;
}

export function tasksForShard(
  tasks: readonly TaskSpec[],
  root: string,
  index: number,
  total: number,
): TaskSpec[] {
  return tasks.map((task) =>
    task.id === root
      ? {
          ...task,
          env: {
            ...(task.env ?? {}),
            ODU_SHARD_INDEX: String(index),
            ODU_SHARD_TOTAL: String(total),
          },
        }
      : task,
  );
}

export function dependencyClosure(
  tasks: readonly TaskSpec[],
  root: string,
): TaskSpec[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const wanted = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || wanted.has(id)) continue;
    wanted.add(id);
    for (const dep of byId.get(id)?.needs ?? []) queue.push(dep);
  }
  return tasks.filter((task) => wanted.has(task.id));
}

export interface ShardLaneProjection {
  setupId: string;
  rootId: string;
  nodeIds: string[];
  publicId(laneNode: string): string;
}

/** The one mapping from a runner-local node id to its fan-in shard node. */
export function shardLaneProjection(
  platform: string,
  topology: ShardTopology,
  index: number,
): ShardLaneProjection {
  const publicId = (laneNode: string): string =>
    fanId(
      shardLaneNamepath(
        topology.rootId,
        index,
        topology.total,
        laneNode,
      ),
      platform,
    );
  return {
    publicId,
    setupId: publicId(SETUP),
    rootId: publicId(topology.rootId),
    nodeIds: [SETUP, ...topology.tasks.map((task) => task.id)].map(publicId),
  };
}

/** Add the first-class shard executions to the public run graph. */
export function installShardTopology(
  state: PipelineState,
  platform: string,
  topology: ShardTopology,
): PipelineState {
  if (topology.total <= 1) return state;

  const logicalId = fanId(topology.rootId, platform);
  const root = topology.tasks.find((task) => task.id === topology.rootId);
  if (root === undefined) {
    throw new Error(`odu: shard root ${topology.rootId} is absent from its DAG`);
  }
  const children: string[] = [];
  const nodes = { ...state.nodes };
  for (let index = 0; index < topology.total; index += 1) {
    const projection = shardLaneProjection(platform, topology, index);
    if (index > 0) {
      children.push(projection.setupId);
      nodes[projection.setupId] = pendingNode({
        id: projection.setupId,
        name: shardLaneNamepath(
          topology.rootId,
          index,
          topology.total,
          SETUP,
        ),
        command: "(prepare burst workspace)",
        needs: [],
      });
      for (const task of topology.tasks) {
        if (task.id === topology.rootId) continue;
        const id = projection.publicId(task.id);
        children.push(id);
        nodes[id] = pendingNode({
          id,
          name: shardLaneNamepath(
            topology.rootId,
            index,
            topology.total,
            task.id,
          ),
          command: task.command,
          needs: [...task.needs, SETUP].map(projection.publicId),
        });
      }
    }
    children.push(projection.rootId);
    nodes[projection.rootId] = pendingNode({
      id: projection.rootId,
      name: shardNamepath(topology.rootId, index, topology.total),
      command:
        `ODU_SHARD_INDEX=${index} ODU_SHARD_TOTAL=${topology.total} ` +
        root.command,
      needs:
        index === 0
          ? [...root.needs, SETUP].map((dep) => fanId(dep, platform))
          : [...root.needs, SETUP].map(projection.publicId),
    });
  }

  const order = [...state.order];
  const at = order.indexOf(logicalId);
  order.splice(at < 0 ? order.length : at + 1, 0, ...children);
  return { ...state, order, nodes };
}

export function shardRootIds(
  platform: string,
  topology: ShardTopology,
): string[] {
  return Array.from({ length: topology.total }, (_, index) =>
    shardLaneProjection(platform, topology, index).rootId,
  );
}

export function shardAggregateStatus(
  statuses: readonly NodeStatus[],
): NodeStatus {
  if (statuses.some((value) => value === "pending" || value === "running")) {
    return statuses.some((value) => value !== "pending") ? "running" : "pending";
  }
  if (statuses.includes("errored")) return "errored";
  if (statuses.some((value) => value === "failed" || value === "skipped")) {
    return "failed";
  }
  if (statuses.includes("cancelled")) return "cancelled";
  return "ok";
}

/** Parallel recipe duration is the critical child execution, not lane skew. */
export function shardAggregateDuration(
  nodes: readonly Pick<NodeState, "durationMs">[],
): number {
  return Math.max(0, ...nodes.map((node) => node.durationMs ?? 0));
}
