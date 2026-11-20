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
  type ClaimedRoutes,
  RootToken,
  Routes,
  StateDir,
} from "@odu/cordis/services";
import { authRow } from "./server";
import { readAllow, type GithubConfig } from "./github";

const allow = readAllow("org:juspay");
if (!allow.ok) throw new Error(allow.message);

const CONFIG: GithubConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  allowSpec: "org:juspay",
  allowRules: allow.rules,
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
    const layers: ClaimedRoutes[] = [];
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
      expect(report?.state === "failed" ? (report.fault ?? "") : "").toContain(
        "exactly one row",
      );

      expect(mounts).toBe(0);
      expect(layers).toHaveLength(0);

      // A SQLite file's `-wal` is checkpointed away when its last connection
      // closes, so a WAL still sitting there is a database the refused row left
      // open.
      const db = join(scratch, "auth", "auth.sqlite");
      expect(existsSync(db)).toBe(true);
      expect(existsSync(`${db}-wal`)).toBe(false);

      await run(closeHost(host));
    } finally {
    }
  });
});
