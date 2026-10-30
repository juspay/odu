/**
 * THE COMPOSED WIRE, ONCE — the shapes every face rebuilds when it addresses
 * more than one row.
 *
 * A daemon serves one flat group: the ROOT surface's bare tags plus each
 * sibling's prefixed ones. Three things downstream must agree with that group,
 * and each had been spelled by hand in four or five places:
 *
 *   - the `RpcGroup` a LINK is built over (a link can only encode a tag whose
 *     `Rpc` it holds, so a core-only group cannot send a sibling's call);
 *   - the TYPED CLIENTS, one per sibling, built over a dispatch;
 *   - the option object the projections take (`surfaces` for the argv and MCP
 *     faces), which is a map of the same records.
 *
 * They are derived here from ONE map the caller passes, so adding a row is one
 * entry at each root rather than an edit in six files. This module names no row:
 * it is generic over the surfaces it is given, which is what lets the browser,
 * the argv face, the MCP bridge and the cache's own CLI share it while only the
 * ROOTS decide what a row is.
 */

import { buildSurfaceFace, type SurfaceClientCallable } from "@kolu/surface/client";
import {
  composeSurfaceContracts,
  mergeDisjointGroups,
  type Surface,
} from "@kolu/surface/define";
import type { ExposeMap } from "@kolu/surface/expose";
import type { Rpc, RpcGroup } from "effect/rpc";

/** A sibling, as a root names it: the surface, and how an agent may reach it. */
export interface SiblingSurface {
  readonly surface: Surface<any>;
  readonly expose?: ExposeMap<any>;
}

/**
 * ONE FLAT GROUP for a client to encode against — the core's tags plus each
 * sibling's, composed by the framework's counted merge so a tag two halves both
 * spell is a boot-time error naming them rather than a silent last-writer-wins.
 */
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

/** One scoped surface per sibling — what a client face is built over. */
export function composedSurfaces<S extends Record<string, Surface<any>>>(
  siblings: S,
): { readonly [K in keyof S]: Surface<any> } {
  return composeSurfaceContracts(siblings).siblings;
}

/**
 * ONE TYPED CLIENT PER SIBLING, over a dispatch the caller already holds.
 *
 * The face kolu builds has the surface's OWN member names and the sibling's tag
 * prefix baked in, so a call addresses `surface/<key>/<member>/<verb>` without
 * the caller knowing the prefix.
 */
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
