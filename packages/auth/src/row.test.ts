/**
 * THE ROW'S OWN CLAIM — a refused second resolver leaves NOTHING behind.
 *
 * The broker's rule ("a second claimant installs nothing") is only half the
 * promise: the auth row acquires a database, a resolver, a mount and a route
 * layer in its `apply`, and a row that threw at the claim after three of those
 * would have installed three things and released none. That is what this test
 * stands in the middle of.
 *
 * The setup is the real one: a Cordis host with the services the row needs, a
 * bundle stub that COUNTS mounts, and a `HttpRoutes` stub that counts layers.
 * A sibling row claims the broker first; the auth row then mounts and must fail
 * with the claim's own sentence, leaving the mount count and the route count at
 * what they were — and its database closed (its WAL is checkpointed away when
 * the last connection goes, which is the one observable a closed SQLite file
 * gives from outside).
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { Logger } from "@kolu/surface-daemon";
import { definePlugin } from "@olai/effect-cordis";
import { closeHost, mountPlugin, openHost, provide, rowReport, standing } from "@olai/effect-cordis";
import type { RootedSurfacesRuntime } from "@kolu/surface/server";
import {
  localBroker,
  makeLease,
  PrincipalBroker,
  type PrincipalResolver,
} from "@odu/cordis/principal";
import {
  Bundle,
  Log,
  type HttpRoutes,
  type RowRoutes,
  RootToken,
  Routes,
  StateDir,
} from "@odu/cordis/services";
import { authRow } from "./server";
import type { GithubConfig } from "./github";

const CONFIG: GithubConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  allow: "org:juspay",
  origin: "https://github.test",
  api: "https://api.github.test",
  publicOrigin: "https://odu.test",
};

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("the door's row", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "odu-auth-row-"));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("a refused claim installs no mount, no route, and closes its database", async () => {
    const layers: RowRoutes[] = [];
    const routes: HttpRoutes = {
      add: (layer) => {
        layers.push(layer);
        return () => {
          layers.splice(layers.indexOf(layer) >>> 0, 1);
        };
      },
      layers: () => layers,
    };
    let mounts = 0;

    const broker = localBroker({ door: true });
    // A sibling row claims the door first — what a second identity row would do.
    const squatter = definePlugin({
      name: "squatter",
      needs: [],
      apply: Effect.sync(() => {
        const resolver: PrincipalResolver = {
          acquire: () => makeLease({ kind: "user", login: "squat", role: "owner" }).lease,
          authorize: () => null,
        };
        broker.register(resolver);
      }),
    });

    const run = standing();
    try {
      const host = await run(openHost);
      await run(provide(host, StateDir, () => scratch));
      await run(provide(host, Routes, () => routes));
      await run(provide(host, Log, () => silentLog));
      await run(provide(host, RootToken, () => "operator"));
      await run(provide(host, PrincipalBroker, () => broker));
      await run(
        provide(host, Bundle, () => ({
          mount: () => {
            mounts += 1;
            return { ctx: {}, drop: async () => {} };
          },
        } as unknown as RootedSurfacesRuntime<never>)),
      );

      await run(mountPlugin(host, squatter));
      await run(mountPlugin(host, authRow(CONFIG)));

      const report = (await run(rowReport(host, ["auth"]))).get("auth");
      expect(report?.state).toBe("failed");
      // The claim's own sentence, not a message-match on something else.
      expect(report?.state === "failed" ? (report.fault ?? "") : "").toContain(
        "exactly one row",
      );

      // THE TWO STRUCTURAL FACTS: the refused row mounted nothing and registered
      // no routes, because both acquisitions come after the claim.
      expect(mounts).toBe(0);
      expect(layers).toHaveLength(0);

      // …AND ITS DATABASE IS CLOSED. A SQLite file's `-wal` is checkpointed away
      // when its last connection closes, so a WAL still sitting there is a
      // database the refused row left open.
      const db = join(scratch, "auth", "auth.sqlite");
      expect(existsSync(db)).toBe(true);
      expect(existsSync(`${db}-wal`)).toBe(false);

      await run(closeHost(host));
    } finally {
      // `standing()`'s scope is this test's; nothing to release by hand.
    }
  });
});
