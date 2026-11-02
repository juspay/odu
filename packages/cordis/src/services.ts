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

/** The OLD store a cache migrates from — `$ODU_CACHE_STORE`, or `null` for the
 *  host's own `/nix/store`. Never where the cache keeps objects. */
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

/**
 * EVERY MOUNTED ROW'S CONTRACT VERSION, by row name — the roster's `contract`
 * fields, gathered by the host and published on the identity cell's `rows`.
 *
 * The host COPIES these and reads none of them: each number is its row's own
 * constant, declared beside that row's surface, and what a major or a minor
 * means for it is the row's business. The judge that compares them against what
 * a client reads is `admitService`, which lives with the cell it reads.
 */
export const RowContracts = serviceTag<Readonly<Record<string, string>>>("odu:rowContracts");

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
 * WHICH SIBLING ROWS THIS DAEMON MOUNTS — the host's composition, as a fact a
 * client may read before it draws anything.
 *
 * The browser drew a Tunnel switch and opened a `routes` subscription on every
 * bucket page even on a daemon with no tunnel row; the bridge composed its MCP
 * siblings from a fixed list. Both now ask. The answer is the roster at boot:
 * rows are fixed for a tenure, and a row that leaves takes the daemon with it.
 */
export const SERVICE_ROWS_PATH = "/_odu/rows";

/**
 * ASK A DAEMON WHICH ROWS IT MOUNTS — the one spelling of that question, beside
 * {@link readDoor} and for the same reasons: a second copy is a second parse,
 * and the two readers (a page deciding whether to draw a control, a bridge
 * deciding whether to advertise a verb) must agree.
 *
 * `null` is UNKNOWN (the host did not answer), deliberately not `[]`: a caller
 * that treats an outage as "no rows" hides a control on a server that has it.
 * A caller that can only HIDE — the browser, before its first draw — may fold
 * `null` to `[]` on purpose; it must say so at the fold, and must not do it
 * where it could wait for the answer instead.
 */
export async function readRows(
  origin: string,
  ask: typeof fetch = fetch,
): Promise<ReadonlyArray<string> | null> {
  try {
    const response = await ask(new URL(SERVICE_ROWS_PATH, origin), {
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { rows?: unknown };
    if (!Array.isArray(body.rows)) return null;
    return body.rows.filter((row): row is string => typeof row === "string");
  } catch {
    return null;
  }
}

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
 * A ROW'S ROUTES AND THE PATHS THEY CLAIM — one value, so a layer cannot be
 * registered without saying where it answers.
 *
 * The host's door gate must know, BEFORE it runs a request, whether a path is a
 * route or the shell (the middleware seam cannot rewrite an answer, only skip
 * it). A list of paths kept in the host was a second spelling of every row's
 * routes, and it drifted: the cache's push API (`/_odu/v1/…`) was not on it, so
 * an anonymous push met the sign-in page. The claim lives beside the
 * `HttpRouter.add` calls it describes instead, and the gate composes them.
 *
 * Each entry is exact, or ends in `*` for a WALK — one or more characters after
 * the prefix (`/cache/*` claims `/cache/b/x`, not `/cache/`).
 */
export interface ClaimedRoutes<Layer extends RowRoutes = RowRoutes> {
  readonly layer: Layer;
  readonly paths: ReadonlyArray<string>;
}

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
  /** Add a layer and its claim. The returned function removes THAT one and no
   *  other. */
  add(routes: ClaimedRoutes): () => void;
  /** Every layer registered so far, with its claim, in registration order. Read
   *  once, at bind — by the router for the layers and by the door gate for the
   *  paths. */
  layers(): ReadonlyArray<ClaimedRoutes>;
}

/** ONE PER TENURE, made by whoever owns the tenure — `@odu/host`'s `web.ts`, and
 *  nothing else. The INTERFACE is the vocabulary a row needs (it is what a row
 *  registers into); the FACTORY is a bag of live state, and this package is a
 *  contract: twelve tags, four types and two pure helpers, with no state to
 *  outlive a call. */
export const Routes = serviceTag<HttpRoutes>("odu:httpRoutes");

// ── what a row publishes ────────────────────────────────────────────────────

/** ONE BUCKET'S OWN NAME, as the cache row publishes it. */
export interface BucketDomainFact {
  readonly bucket: string;
  readonly domain: string;
}

/**
 * THE CACHE ROW'S DOMAINS, AS A FACT OTHER ROWS MAY REACT TO.
 *
 * The `cloudflare` row watches this to route a bucket's name; it must not import
 * the cache row's internals (the database, the surface's procedures) to learn a
 * fact the cache already knows. A service key is the safe import: the cache
 * offers it in its own activation, the cloudflare row declares it, and the two
 * never name each other's packages.
 *
 * `subscribe` returns the WITHDRAWAL, and the cache ends every listener when it
 * closes — the same lifetime its own `onChange` has.
 */
export interface BucketDomains {
  /** Every bucket that has a domain, now. */
  current(): readonly BucketDomainFact[];
  subscribe(listener: () => void): () => void;
  /**
   * THE PATHS THE CACHE ROW ANSWERS. A bucket domain forwards EVERY path of
   * its name to this daemon, so the host's gate needs to know what belongs to
   * the cache and what must never answer there: its claims are the whole list.
   */
  paths: ReadonlyArray<string>;
  /**
   * THE BUCKET A PATH NAMES, in either protocol spelling — or `null` when it
   * names none. The grammar is the cache row's; the host's bucket-domain gate
   * asks this rather than parsing `/cache/<name>` itself.
   */
  bucketOf(path: string): string | null;
}

export const BucketDomains = serviceTag<BucketDomains>("odu:bucketDomains");

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
 *  siblings mount on.
 *
 *  `contract` is the row's OWN version, `major.minor` — the constant its surface
 *  module declares beside the surface it versions. A row's surface changing is
 *  that row's bump and no other's: a client that reads only the runs is never
 *  refused because the cache moved. The host gathers these into
 *  {@link RowContracts} and knows nothing of what they mean. */
export interface Row {
  readonly name: string;
  readonly key: string | null;
  readonly plugin: Plugin;
  readonly agent: RowAgent;
  readonly contract: string;
}
