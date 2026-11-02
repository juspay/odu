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
import {
  CI_NEEDS,
  ifMountedAll,
  oduServiceSurface,
  type RowNeeds,
} from "@odu/service-client/surface";
import { CACHE_KEY, CACHE_NEEDS, oduCacheSurface } from "@odu/cache/surface";
import { AUTH_KEY, AUTH_NEEDS, oduAuthSurface } from "@odu/auth/surface";
import { CLOUDFLARE_KEY, CLOUDFLARE_NEEDS, oduCloudflareSurface } from "@odu/cloudflare/surface";
import { authorizationHeaders } from "@odu/auth/cli";
import { connectOrStart } from "@odu/launch/webLauncher";
import type { ServiceConnection } from "@odu/service-client/dial";

/**
 * ONE FLAT GROUP: the runs' bare tags plus each sibling's prefixed ones,
 * composed by the framework's own counted merge — so a tag two rows both spell
 * is a boot-time error naming both, rather than a last-writer-wins map that
 * drops one in silence.
 */
export const SERVICE_SIBLINGS = {
  [CACHE_KEY]: oduCacheSurface,
  [AUTH_KEY]: oduAuthSurface,
  [CLOUDFLARE_KEY]: oduCloudflareSurface,
} as const;

/** The same map, as the group a link encodes against. Derived from
 *  {@link SERVICE_SIBLINGS} rather than beside it: two spellings of one row set,
 *  four lines apart, is a row that can be added to one and forgotten in the
 *  other. */
export const SERVICE_WIRE_GROUP = composedWire(oduServiceSurface, SERVICE_SIBLINGS);

/**
 * WHAT THE COMPOSED FACES READ — `odu surface` and the `odu mcp` bridge project
 * every row the daemon mounts: the runs always, each sibling when it is there.
 *
 * Every other command declares only its own row (`odu run` the runs, `odu cache`
 * the cache — each row's `*_NEEDS`), so a daemon whose cache moved a major is
 * still one `odu run` can drive.
 */
export const EVERY_ROW_NEEDS: RowNeeds = {
  ...CI_NEEDS,
  ...ifMountedAll({ ...CACHE_NEEDS, ...AUTH_NEEDS, ...CLOUDFLARE_NEEDS }),
};

/**
 * REACH THE SERVICE AS THE CREDENTIAL THIS MACHINE HOLDS FOR IT.
 *
 * The one way a public command should dial, so nobody has to remember it: a
 * server with a door answers an unauthenticated socket with its identity and
 * nothing else, and a face that forgot the token would look like a board with
 * no data rather than like a refusal. `$ODU_TOKEN` first, then the entry
 * `odu auth login` wrote for that origin — the same order the docs promise.
 *
 * `needs` is what the calling command reads; a daemon is adopted on those rows
 * and no others.
 */
export function connectToService(
  origin: string | undefined,
  opts: { needs: RowNeeds; warned?: Set<string> },
): Promise<ServiceConnection> {
  return connectOrStart(origin, {
    group: SERVICE_WIRE_GROUP,
    authorization: (resolved) => authorizationHeaders(process.env, resolved),
    ...opts,
  });
}
