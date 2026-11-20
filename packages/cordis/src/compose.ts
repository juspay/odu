import { buildSurfaceFace, type SurfaceClientCallable } from "@kolu/surface/client";
import {
  composeSurfaceContracts,
  mergeDisjointGroups,
  type Surface,
} from "@kolu/surface/define";
import type { ExposeMap } from "@kolu/surface/expose";
import type { Rpc, RpcGroup } from "effect/rpc";

export interface SiblingSurface {
  readonly surface: Surface<any>;
  readonly expose?: ExposeMap<any>;
}

export function composedWire<S extends Record<string, Surface<any>>>(
  core: Surface<any>,
  siblings: S,
): RpcGroup.RpcGroup<Rpc.Any> {
  const scoped = composeSurfaceContracts(siblings).siblings as Record<
    string,
    { readonly group: RpcGroup.RpcGroup<Rpc.Any> }
  >;
  return mergeDisjointGroups({
    core: core.group,
    ...Object.fromEntries(
      Object.entries(scoped).map(([key, sibling]) => [key, sibling.group]),
    ),
  });
}

export function composedSurfaces<S extends Record<string, Surface<any>>>(
  siblings: S,
): { readonly [K in keyof S]: Surface<any> } {
  return composeSurfaceContracts(siblings).siblings;
}

export function composedClients<S extends Record<string, Surface<any>>>(
  siblings: S,
  dispatch: Parameters<typeof buildSurfaceFace>[1],
): { readonly [K in keyof S]: SurfaceClientCallable } {
  const scoped = composedSurfaces(siblings);
  return Object.fromEntries(
    Object.keys(siblings).map((key) => [
      key,
      buildSurfaceFace(scoped[key]!, dispatch) as unknown as SurfaceClientCallable,
    ]),
  ) as { readonly [K in keyof S]: SurfaceClientCallable };
}
