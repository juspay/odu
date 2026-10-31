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

/** Does this daemon have a door? `true` when an identity provider's row is
 *  mounted, decided by the host when it reads the one environment it reads.
 *
 *  Provided BEFORE any row mounts, because the runs' row publishes it on the
 *  service cell and cannot learn it from the broker: the row that registers a
 *  resolver is waiting for the bundle the runs offer, so at the runs' own
 *  `apply` time that registration has not happened. */
export const AuthDoor = serviceTag<boolean>("odu:authDoor");

/** The route layer a row owns, typed as the seam that consumes it. */
export type RowRoutes = NonNullable<ServeSurfaceAppOptions["routes"]>;

/**
 * THE HTTP ROUTER MOUNT — the one listener's app routes, which a row adds its
 * own layer to.
 *
 * A row with protocol routes (the cache's Nix API) registers them where it
 * activates, so the layer arrives with the row rather than being collected by a
 * host that has to know what the row is.
 */
export interface HttpRoutes {
  add(routes: RowRoutes): void;
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
