import type { NodeState } from "@odu/run-client/surface";

export type NodePatch = Partial<NodeState> & { readonly clearPush?: boolean };

export function applyNodePatch(prev: NodeState, patch: NodePatch): NodeState {
  const { clearPush = false, ...fields } = patch;
  if (!clearPush) return { ...prev, ...fields };
  const { push: _push, ...kept } = { ...prev, ...fields };
  return kept;
}

export function nodePatchChanges(prev: NodeState, patch: NodePatch): boolean {
  const { clearPush = false, ...fields } = patch;
  if (clearPush && prev.push !== undefined) return true;
  const keys = Object.keys(fields) as (keyof NodeState)[];
  return keys.some((k) => fields[k] !== prev[k]);
}
