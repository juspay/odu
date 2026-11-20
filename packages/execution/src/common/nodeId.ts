import type { PipelineState } from "@odu/run-client/surface";
import { isSetupNode, onPlatform, splitFanId } from "@odu/run-client/nodeId";

export function transitiveDependents(
  order: readonly string[],
  needsOf: (id: string) => readonly string[],
  root: string,
): Set<string> {
  const out = new Set<string>([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of order) {
      if (out.has(id)) continue;
      if (needsOf(id).some((d) => out.has(d))) {
        out.add(id);
        grew = true;
      }
    }
  }
  out.delete(root);
  return out;
}

export function parseAtPlatform(selector: string): string | null {
  if (!selector.startsWith("@")) return null;
  const platform = selector.slice(1);
  if (platform === "" || platform.includes("@")) return null;
  return platform;
}

export function matchNodeIds(
  state: Pick<PipelineState, "order" | "nodes">,
  token: string,
): string[] {
  if (state.nodes[token] !== undefined) return [token];
  return state.order.filter((id) => {
    if (id === token) return true;
    if (id.endsWith(`::${token}`) || id.includes(`::${token}@`)) return true;
    return splitFanId(id).namepath === token;
  });
}

export function resolveNodeId(state: PipelineState, token: string): string {
  const matches = matchNodeIds(state, token);
  if (matches.length === 1 && matches[0] !== undefined) return matches[0];
  throw new Error(
    matches.length === 0
      ? `odu: no node matches "${token}" (try: ${state.order.join(", ")})`
      : `odu: "${token}" is ambiguous (${matches.join(", ")})`,
  );
}


export function resolveRerunTargets(
  state: PipelineState,
  selector: string,
): string[] {
  const platform = parseAtPlatform(selector);
  if (platform !== null) {
    const ids = state.order.filter(
      (id) => onPlatform(id, platform) && !isSetupNode(id),
    );
    if (ids.length === 0) {
      throw new Error(`odu: no nodes on platform "${platform}"`);
    }
    return ids;
  }
  if (selector.startsWith("@")) {
    throw new Error(
      `odu: not a node id, @platform, or recipe: ${selector}`,
    );
  }

  const matches = matchNodeIds(state, selector);
  if (matches.length === 0) {
    throw new Error(
      `odu: no node matches "${selector}" (try: ${state.order.join(", ")})`,
    );
  }
  return matches;
}

export function minimalRerunRoots(
  state: PipelineState,
  targets: string[],
): string[] {
  const needsOf = (id: string): readonly string[] =>
    state.nodes[id]?.needs ?? [];
  const coveredBy = new Map<string, Set<string>>();
  for (const t of targets) {
    coveredBy.set(t, transitiveDependents(state.order, needsOf, t));
  }
  return targets.filter((id) => {
    for (const other of targets) {
      if (other === id) continue;
      if (coveredBy.get(other)?.has(id) === true) return false;
    }
    return true;
  });
}
