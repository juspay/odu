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
 * siblings' contracts belong to their own packages, and this package is a ROW:
 * it names the cache's SURFACE — a declared door of another row, which is what
 * the fence allows — and nothing of that row's server. A row that adds a surface
 * adds it here; `packages/host/src/fence.test.ts` asserts that the keys the
 * browser, this argv face and the daemon's roster all use are one word.
 *
 * ## What it is NOT
 *
 * The `control` sibling. It exists on the wire — the daemon's supervisor probes
 * it — but no face sends one of its tags, and a face that could would be able to
 * drain a daemon it has no business ending. A client addresses what it is
 * allowed to address.
 */

import { composedWire } from "@odu/cordis/compose";
import { oduServiceSurface } from "@odu/service-client/surface";
import { CACHE_KEY, oduCacheSurface } from "@odu/cache/surface";

/**
 * ONE FLAT GROUP: the runs' bare tags plus each sibling's prefixed ones,
 * composed by the framework's own counted merge — so a tag two rows both spell
 * is a boot-time error naming both, rather than a last-writer-wins map that
 * drops one in silence.
 */
export const SERVICE_SIBLINGS = { [CACHE_KEY]: oduCacheSurface } as const;

/** The same map, as the group a link encodes against. Derived from
 *  {@link SERVICE_SIBLINGS} rather than beside it: two spellings of one row set,
 *  four lines apart, is a row that can be added to one and forgotten in the
 *  other. */
export const SERVICE_WIRE_GROUP = composedWire(oduServiceSurface, SERVICE_SIBLINGS);
