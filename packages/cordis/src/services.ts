/**
 * THE VOCABULARY THE HOST AND ITS ROWS SHARE, and the one place it can live.
 *
 * A row is a `definePlugin`: it declares what it NEEDS, the runtime holds its
 * fibre `PENDING` until something has provided it, and it unloads when the
 * provider leaves. So the host's job splits in two — it provides these, and it
 * mounts the rows — and no row reads an environment, a global, or a module the
 * host happens to have imported.
 *
 * **Why this is a package of its own.** `@odu/host` names every row and belongs
 * to none of them, and a row may not import it: a face that reached the host to
 * bootstrap would carry every row's server to reach the code that starts one. A
 * row's own package cannot hold the tags the OTHER rows need either. So the
 * vocabulary sits in a module that belongs to neither side, and both name it.
 *
 * The keys are minted with `serviceTag`, which is ONE declaration spoken in both
 * vocabularies: the string is what the row's `inject` names to Cordis and the
 * tag is what its `apply` yields to the compiler. `definePlugin` derives the
 * first from the second, so a row cannot name one without having the other.
 */

import type { Logger } from "@kolu/surface-daemon";
import type { Surface, SurfaceSpec } from "@kolu/surface/define";
import type { ExposeMap } from "@kolu/surface/expose";
import type { RootedSurfacesRuntime } from "@kolu/surface/server";
import type { ServeSurfaceAppOptions } from "@kolu/surface-app/serve";
import { type Plugin, serviceTag } from "@olai/effect-cordis";

// ── what the host provides ──────────────────────────────────────────────────

/** The per-user state root the catalog and the cache live under — read ONCE, by
 *  the host, because this is the one place in odu that reads an environment. */
export const StateDir = serviceTag<string>("odu:stateDir");

/** The daemon's own home: the gate, the control socket, the crash log. */
export const DaemonHome = serviceTag<string>("odu:daemonHome");

/** Where this process is BOUND — the OS's answer, not the request, so a caller
 *  reading the identity cell learns the address that actually works. */
export const BoundOrigin = serviceTag<string>("odu:boundOrigin");

/** The address a bucket is reachable at from outside, when a proxy stands in
 *  front. `null` means "nothing is in front": the bound origin IS the public
 *  one. Only a substituter URL uses it. */
export const PublicOrigin = serviceTag<string | null>("odu:publicOrigin");

/** The operator's root token, or `null` when none is configured — in which case
 *  every administrative cache verb refuses with `no_root_token` while the
 *  substituter keeps serving. */
export const RootToken = serviceTag<string | null>("odu:rootToken");

/** The store URI a cache's blobs live in — `$ODU_CACHE_STORE`, or `null` for the
 *  host's own `/nix/store`. */
export const NixStore = serviceTag<string | null>("odu:nixStore");

/** WHICH APPLICATION this is, for the cell a client compares before it adopts a
 *  running daemon.
 *
 *  Spelled here rather than imported from `@odu/service-client` because this
 *  module names no row: the four fields are that contract's `ServiceBuild`, and
 *  a tag whose type came from a row would make this package the second thing a
 *  row cannot import. */
export const Build = serviceTag<{
  readonly oduVersion: string;
  readonly commit: string | null;
  readonly buildId: string | null;
  readonly self: string | null;
}>("odu:build");

/** Where a daemon narrates itself. */
export const Log = serviceTag<Logger>("odu:log");

/** End the tenure — the frozen control fragment's `drain`, wired to this
 *  process's own stop. A supervisor asks; the daemon decides how it ends. */
export const Shutdown = serviceTag<() => void>("odu:shutdown");

/**
 * THE COMPOSED BUNDLE a row joins — the runs' rooted runtime, provided by the
 * host once the row that owns it is up.
 *
 * A SIBLING mounts itself on this in its own `apply` and drops the mount in its
 * finalizer: the framework's transactional door walks the arriving surface,
 * proves the whole route set disjoint across root and siblings, and commits
 * nothing if it fails. Nothing outside a row ever mounts on it.
 */
export const Bundle = serviceTag<RootedSurfacesRuntime<never>>("odu:bundle");

/** WHERE THE HOST ANSWERS "do you have a door?" — one path, spoken by the
 *  listener that serves it and the page that asks before it draws.
 *
 *  Here rather than beside the door's row because the HOST serves it and the
 *  BROWSER asks it: a host package may not import a row, and the browser holds
 *  only the contracts. */
export const SERVICE_DOOR_PATH = "/_odu/door";

/**
 * ASK A DAEMON WHETHER IT HAS A DOOR — the ONE spelling of the question.
 *
 * Two faces ask it: the browser, before it draws anything, and the CLI's MCP
 * bridge, before it advertises the door's verbs. A second copy is a second
 * parse of the same body, and the two answers decide different things (a board
 * or a sign-in page; a tool list), so they must agree.
 *
 * `null` is UNKNOWN — the host did not answer — and it is deliberately not
 * `false`: a caller that treats an outage as "loopback" draws controls for a
 * server that is not there. The caller decides what an unknown answer means;
 * the answer itself says only what was read.
 *
 * The request is BOUNDED because this runs where a foreign process may hold the
 * socket: a program that accepts and says nothing would otherwise hold a
 * browser's first paint, or a bridge's whole startup, open.
 */
export async function readDoor(
  origin: string,
  ask: typeof fetch = fetch,
): Promise<boolean | null> {
  try {
    const response = await ask(new URL(SERVICE_DOOR_PATH, origin), {
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { door?: unknown };
    return body.door === true;
  } catch {
    return null;
  }
}

/**
 * THE PARAGRAPHS AN AGENT IS TAUGHT, composed from the rows STANDING — core
 * first, then each sibling.
 *
 * One function because two doors teach it: the daemon's `/mcp` route and the
 * CLI's stdio bridge. They are the same vocabulary reached two ways, and a
 * bridge that composed its own list taught one sentence less the moment a row
 * was added (which is what happened to the door's paragraph).
 */
export function agentInstructions(
  core: RowAgent | null,
  siblings: Readonly<Record<string, RowAgent>>,
): string {
  return [core?.instructions, ...Object.values(siblings).map((row) => row.instructions)]
    .filter((text): text is string => text !== undefined && text !== "")
    .join("\n\n");
}

/** The route layer a row owns, typed as the seam that consumes it. */
export type RowRoutes = NonNullable<ServeSurfaceAppOptions["routes"]>;

/**
 * THE HTTP ROUTER MOUNT — the one listener's app routes, which a row adds its
 * own layer to.
 *
 * A row with protocol routes (the cache's Nix API, the door's sign-in flow)
 * registers them where it activates, so the layer arrives with the row rather
 * than being collected by a host that has to know what the row is.
 *
 * `add` returns the WITHDRAWAL, and that is not bookkeeping: a row whose `apply`
 * fails after it registered its routes would otherwise leave them answering on a
 * listener whose row has gone — and, for the door, calling into a closed
 * database. The host applies the layers it is holding at each bind.
 */
export interface HttpRoutes {
  /** Add a layer. The returned function removes THAT layer and no other. */
  add(routes: RowRoutes): () => void;
  /** Every layer registered so far, in registration order. Read once, at bind. */
  layers(): ReadonlyArray<RowRoutes>;
}

/** ONE PER TENURE, made by whoever owns the tenure — `@odu/host`'s `web.ts`, and
 *  nothing else. The INTERFACE is the vocabulary a row needs (it is what a row
 *  registers into); the FACTORY is a bag of live state, and this package is a
 *  contract: eleven tags, four types and two pure helpers, with no state to
 *  outlive a call. */
export const Routes = serviceTag<HttpRoutes>("odu:httpRoutes");

// ── what a row is ───────────────────────────────────────────────────────────

/** What an AGENT is told about one row: its surface, its own exposure policy,
 *  and the paragraph it wants taught at `initialize`.
 *
 *  A field of the row rather than something the transport looks up, because it
 *  is the row's vocabulary: the transport composes the records and knows what
 *  none of them mean. */
export interface RowAgent {
  readonly surface: Surface<SurfaceSpec>;
  readonly expose: ExposeMap<SurfaceSpec>;
  readonly instructions: string;
}

/** ONE ROW, fixed at boot.
 *
 *  `key` is the word its surface is served under — the sibling segment on the
 *  wire, the subcommand in argv, and the word a browser folds its health under.
 *  `null` for the ROOT row, whose members keep the bare tags.
 *
 *  `plugin` is the `definePlugin` this row is mounted as — EVERY row is one,
 *  including the runs': a plugin can build a rooted bundle inside its own
 *  `apply` and `offer` it, so the runs' row owns its runtime and closes it.
 *  `key` null means "the wire's ROOT": the row that offers `Bundle`, which the
 *  siblings mount on. */
export interface Row {
  readonly name: string;
  readonly key: string | null;
  readonly plugin: Plugin;
  readonly agent: RowAgent;
}
