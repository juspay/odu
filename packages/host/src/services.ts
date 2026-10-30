/**
 * WHAT THE HOST PROVIDES — the facts every row is handed, as Effect services.
 *
 * A row is a `definePlugin`: it declares what it NEEDS, the runtime holds its
 * fibre `PENDING` until something has provided it, and it unloads when the
 * provider leaves. So the host's job splits cleanly in two — it provides these,
 * and it mounts the rows — and no row reads an environment, a global, or a
 * module the host happens to have imported.
 *
 * The keys here are minted with `serviceTag`, which is ONE declaration spoken
 * in both vocabularies: the string is what the row's `inject` names to Cordis
 * and the tag is what its `apply` yields to the compiler. `definePlugin`
 * derives the first from the second, so a row cannot name one without having
 * the other.
 *
 * ## What is deliberately NOT a service
 *
 * `@odu/web-ui`'s bundle path ({@link WebDist}) is the LISTENER's business —
 * `servingOptions` takes it, the host has it, and no row renders anything. It
 * is provided anyway because the packaging assertion and the serve are two
 * halves of one fact, and a row that asked for it would be a row that knows it
 * is being served by a web listener at all.
 */

import type { ServeSurfaceAppOptions } from "@kolu/surface-app/serve";
import type { Surface, SurfaceSpec } from "@kolu/surface/define";
import type { ExposeMap } from "@kolu/surface/expose";
import type { RootedSurfacesRuntime } from "@kolu/surface/server";
import type { ServiceBuild } from "@odu/service-client/surface";
import type { Logger } from "@kolu/surface-daemon";
import { serviceTag } from "@olai/effect-cordis";

/** The per-user state root the catalog and the cache live under — read ONCE,
 *  by the host, because this is the one place in odu that reads an
 *  environment. */
export const StateDir = serviceTag<string>("odu:stateDir");

/** The daemon's own home: the gate, the control socket, the crash log. */
export const DaemonHome = serviceTag<string>("odu:daemonHome");

/** Where this process is BOUND — the OS's answer, not the request, so a caller
 *  reading the identity cell learns the address that actually works. */
export const BoundOrigin = serviceTag<string>("odu:boundOrigin");

/** The address a bucket is reachable at from outside, when a proxy stands in
 *  front. `null` means "nothing is in front": the bound origin IS the public
 *  one. Only a substituter URL uses it — the board, the identity cell and the
 *  websocket stay on the bound origin, because those are addresses this
 *  process has to be reachable at to serve at all. */
export const PublicOrigin = serviceTag<string | null>("odu:publicOrigin");

/** WHICH APPLICATION this is, for the cell a client compares before it adopts
 *  a running daemon. */
export const Build = serviceTag<ServiceBuild>("odu:build");

/** Where a daemon narrates itself. A foreground server writes to a person's
 *  terminal; the backgrounded one writes JSON to a file nobody reads until
 *  something goes wrong. */
export const Log = serviceTag<Logger>("odu:log");

/** The built browser bundle. Required: `serveSurfaceApp` treats a missing
 *  client dist as "no static route" and a nonexistent one as a 404, so the
 *  packaged contract is asserted before this is provided. */
export const WebDist = serviceTag<string>("odu:webDist");

/** End the tenure — the frozen control fragment's `drain`, wired to this
 *  process's own stop. A supervisor asks; the daemon decides how it ends. */
export const Shutdown = serviceTag<() => void>("odu:shutdown");

/** The operator's root token, or `null` when none is configured — in which
 *  case every administrative cache verb refuses with `no_root_token` while the
 *  substituter keeps serving. Read from `$ODU_ROOT_TOKEN` by the host, because
 *  the composition root is the one place that reads an environment. */
export const RootToken = serviceTag<string | null>("odu:rootToken");

/** Browser origins allowed beyond same-origin. The gate runs on the RAW
 *  pre-upgrade socket for the websocket and on `Origin` for `/mcp`, and it is
 *  ONE list so the two doors cannot drift apart. */
export const AllowedOrigins = serviceTag<ReadonlyArray<string>>("odu:allowedOrigins");

/** The store URI a cache's blobs live in — `$ODU_CACHE_STORE`, or `null` for
 *  the host's own `/nix/store`. Provided by the host rather than read by the
 *  cache because the composition root is the only place that reads an
 *  environment, and because the e2e suite points the whole cache at a throwaway
 *  chroot store by setting it. */
export const NixStore = serviceTag<string | null>("odu:nixStore");

/** The route layer a row owns, typed as the seam that consumes it. */
export type RowRoutes = NonNullable<ServeSurfaceAppOptions["routes"]>;

/** A row's share of the listener: what it serves, and how it is released.
 *
 *  `runtime` is the ROOTED bundle the row built — the ci row's is the service
 *  runtime, with the daemon's frozen `control` fragment already mounted on it —
 *  or `null` for a row that only adds a sibling and/or routes. `mount` is how
 *  such a row joins the bundle: the root runtime's own transactional door, so
 *  the framework's disjointness proof runs over the arriving surface rather
 *  than over a merge this file performed by hand.
 *
 *  `routes` is an HTTP layer the row owns — the cache's protocol, the ci row's
 *  `/mcp` — merged beside the shell. A row with no routes contributes nothing.
 */
export interface RowContribution {
  readonly runtime: RootedSurfacesRuntime<never> | null;
  /** Join the composed bundle — the ROOTed runtime the runs row brought. A row
   *  that IS the root has nothing to attach: its surface is the bundle. */
  readonly attach: ((root: RootedSurfacesRuntime<never>) => void) | null;
  readonly routes: RowRoutes | null;
  /** What an AGENT is told about this row: its surface, its own exposure
   *  policy, and the paragraph it wants taught at `initialize`.
   *
   *  On the row rather than in the transport, because it is the row's
   *  vocabulary: the transport composes them and knows what none of them mean. */
  readonly agent: RowAgent | null;
  /** The row's own wiring death, if it has one — a runtime that has faulted
   *  answers nothing while the process stays alive and the socket stays open,
   *  which is the documented zombie. The host observes it and treats it as
   *  fatal; nothing else in the process can.
   *
   *  Releasing what a row built is NOT here: it is the row's activation
   *  cleanup, a finalizer on the plugin's own scope, so Cordis runs it in
   *  reverse order when the tenure ends — the cache's `close()` and the
   *  service's poller are the same kind of thing and are released the same
   *  way. */
  readonly done: Promise<void> | null;
}

/** One row's contribution to the agent-facing door. */
export interface RowAgent {
  readonly surface: Surface<SurfaceSpec>;
  readonly expose: ExposeMap<SurfaceSpec>;
  readonly instructions: string;
}

/** THE ROW TABLE — how a mounted row hands the host what it built.
 *
 *  A plain mutable record rather than a service per row, because the set of
 *  rows is FIXED at boot and the host reads it exactly once, after every row
 *  has settled. A row writes its contribution as its last act before returning
 *  and removes it in its cleanup, so the table is empty again by the time
 *  `closeHost` has finished — which is what makes a second mount of the same
 *  name in one tenure impossible rather than merely unlikely.
 */
export interface RowTable {
  /** Publish what a row built. Refuses a duplicate name: two rows under one key
   *  would mean one of them silently serving nothing. */
  put(name: string, contribution: RowContribution): void;
  /** Take it back — the row's own cleanup, and only after it closed. */
  drop(name: string): void;
  /** What every settled row published, in mount order. */
  read(): ReadonlyArray<readonly [string, RowContribution]>;
}

export const Rows = serviceTag<RowTable>("odu:rows");

/** One, fresh per tenure. */
export function createRowTable(): RowTable {
  const held = new Map<string, RowContribution>();
  return {
    put: (name, contribution) => {
      if (held.has(name)) {
        throw new Error(`odu: two rows published under the name "${name}"`);
      }
      held.set(name, contribution);
    },
    drop: (name) => {
      held.delete(name);
    },
    read: () => [...held],
  };
}
