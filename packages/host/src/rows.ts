/**
 * THE ROWS, FIXED AT BOOT.
 *
 * Three lines of data and the composition they feed, and both halves are
 * deliberate. **Fixed**, because a daemon whose served set can move is a
 * daemon whose every client has to re-dial on a roster change — kolu's
 * rooted-bundle door supports it, and odu has no product reason to want it:
 * `odu web` serves the runs and the cache, and which of those exists is a fact
 * about the BINARY rather than about the machine or the request.
 *
 * A row is named ONCE, here, and the name is three things: the plugin's `name`
 * (what the runtime binds its fibre under and what `settled` waits on), the
 * SIBLING KEY its surface is served under (or `ci`, which is the wire's
 * unprefixed ROOT), and the key a browser's `connectSurfaces` folds its health
 * under. `rows.test.ts` holds the first two together, because a row whose three
 * names disagree is a row a client cannot address.
 *
 * ## Composition is the framework's, not this file's
 *
 * The runs row brings the ROOTED bundle — the service runtime, with the
 * frozen `control` fragment already mounted on it. Every other row brings a
 * SURFACE and asks to be mounted as a sibling through that bundle's own
 * transactional `mount`, which walks the arriving surface, proves the whole
 * route set disjoint across root and siblings, and commits nothing if it fails
 * — so a collision names the row that caused it instead of silently dropping a
 * member.
 *
 * That is the shape `@olai/effect-cordis`'s host describes (a root, rows
 * beside it, teardown in reverse) and the one kolu's own composer uses, arrived
 * at from this side: composing by hand would be a second implementation of
 * `mergeDisjointGroups` with none of its proof.
 */

import { Layer } from "effect";
import type { Plugin } from "@olai/effect-cordis";
import type { RootedSurfacesRuntime } from "@kolu/surface/server";
import { ciRow } from "./rows/ci";
import type { RowContribution, RowRoutes } from "./services";

/** One row's identity: the word the runtime binds it under, and the slot its
 *  surface occupies in the composed wire. */
export interface Row {
  readonly name: string;
  /** The sibling key its surface is served under — absent for the ROOT. */
  readonly key: string | null;
  readonly plugin: Plugin;
}

export const ROWS: ReadonlyArray<Row> = [
  // The runs. The ROOT, because the wire is ABOUT them: its members are the
  // bare tags every face was published against.
  { name: "ci", key: null, plugin: ciRow },
];

/** What the rows composed into: one live generation, and the routes beside it. */
export interface Composed {
  readonly runtime: RootedSurfacesRuntime<never>;
  /** Every row's routes, merged — `null` when no row owns any. */
  readonly routes: RowRoutes | null;
}

/**
 * FOLD THE SETTLED ROWS INTO ONE THING TO SERVE.
 *
 * Refuses rather than degrades. A tenure that mounted three of its four rows
 * would serve a wire whose members silently answer "unknown verb" — the failure
 * a face reports as "this build is too old for that service" — and the daemon
 * would look healthy. So every missing or doubled row is a REFUSAL here, at
 * boot, with the row named.
 */
export function composeRows(
  settledRows: ReadonlyArray<readonly [string, RowContribution]>,
  // The row SET is a parameter rather than a closed-over `ROWS` so a suite can
  // compose a two-row daemon without a second row existing in this build — the
  // refusals below are about the composition, not about which rows ship.
  rows: ReadonlyArray<Row> = ROWS,
): Composed {
  const byName = new Map(settledRows);
  const missing = rows.filter((row) => !byName.has(row.name)).map((row) => row.name);
  if (missing.length > 0) {
    throw new Error(
      `odu: the rows ${missing.join(", ")} did not publish anything — a ` +
        "daemon that serves half its surface answers `unknown verb` to the " +
        "other half, which reads as a build skew rather than as a fault here.",
    );
  }

  const root = rows.find((row) => row.key === null);
  if (root === undefined) {
    throw new Error("odu: no row owns the ROOT surface — the wire has no floor");
  }
  const rootContribution = byName.get(root.name) as RowContribution;
  if (rootContribution.runtime === null) {
    throw new Error(`odu: the row "${root.name}" owns the root but built no runtime`);
  }
  const runtime = rootContribution.runtime;

  const routes: RowRoutes[] = [];
  for (const row of rows) {
    const contribution = byName.get(row.name) as RowContribution;
    if (contribution.routes !== null) routes.push(contribution.routes);
    // The root's own surface is already in `runtime`; every OTHER row joins it
    // through the bundle's transactional door.
    if (row.key !== null) {
      const mount = contribution.mount;
      if (mount === null) {
        throw new Error(`odu: the row "${row.name}" is a sibling but asked for no mount`);
      }
      if (mount.key !== row.key) {
        throw new Error(
          `odu: the row "${row.name}" mounted itself as "${mount.key}" — a ` +
            "row's name and its sibling key are one name, because that is what " +
            "a client folds its health under",
        );
      }
      runtime.mount(mount.key, mount.surface, mount.deps);
    }
  }
  // MERGED, not ordered: `HttpRouter` ranks by specificity, so a literal
  // `/mcp` or `/:bucket/nix-cache-info` beats the shell's `GET /*` catch-all
  // whichever order the rows were mounted in.
  return { runtime, routes: routes.length === 0 ? null : routes.reduce((all, one) => Layer.merge(all, one)) };
}
