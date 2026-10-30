/**
 * THE WIRE — every row's tags in one group, for a CLIENT to encode against.
 *
 * A link encodes a request from the `Rpc` it looks up by TAG, so a client that
 * addressed a sibling's member through a link built from the core's group alone
 * would find no descriptor for it and fail on the frame it was trying to send.
 * The daemon serves one flat group; a face must address one.
 *
 * ## Why this is a module and not a line in the dial
 *
 * `@odu/service-client`'s dial is browser-safe and knows only the core. The
 * siblings' contracts belong to their own packages, so the composition is the
 * ROOT's — this package — and it is the same list as {@link ROWS}: a row that
 * adds a surface adds it here, and the fence (phase 5) asserts the two agree.
 *
 * ## What it is NOT
 *
 * The `control` sibling. It exists on the wire — the daemon's supervisor probes
 * it — but no face sends one of its tags, and a face that could would be able to
 * drain a daemon it has no business ending. A client addresses what it is
 * allowed to address.
 */

import {
  composeSurfaceContracts,
  mergeDisjointGroups,
} from "@kolu/surface/define";
import type { RpcGroup } from "effect/rpc";
import type { Rpc } from "effect/rpc";
import { oduServiceSurface } from "@odu/service-client/surface";
import { oduCacheSurface } from "@odu/cache/surface";

/**
 * ONE FLAT GROUP: the runs' bare tags plus each sibling's prefixed ones,
 * composed by the framework's own counted merge — so a tag two rows both spell
 * is a boot-time error naming both, rather than a last-writer-wins map that
 * drops one in silence.
 */
export const SERVICE_WIRE_GROUP: RpcGroup.RpcGroup<Rpc.Any> = mergeDisjointGroups({
  core: oduServiceSurface.group,
  cache: composeSurfaceContracts({ cache: oduCacheSurface }).siblings.cache.group,
});
