import { readFileSync } from "node:fs";
import { join } from "node:path";
import { daemonHome } from "@kolu/surface-daemon";
import { survivableSpawnDriver } from "@kolu/surface-daemon-supervisor";
import {
  ODU_CHILD_ENV_KEYS,
  pickEnv,
  survivableSpawnPlan,
} from "@odu/execution/coordinator/spawn";
import { ODU_VERSION } from "@odu/execution/common/version";
import { serviceOrigin } from "@odu/service-client/endpoint";
import { webAppNamespace, webHomeOptions } from "@odu/service-client/socket";
import type { ServiceBuild } from "@odu/service-client/surface";
import { Effect } from "effect";

const DIST_ENV = "ODU_WEB_DIST";

export function webHome(
  origin: string = serviceOrigin(),
  env: Record<string, string | undefined> = process.env,
): ReturnType<typeof daemonHome> {
  return daemonHome(webHomeOptions(origin, env));
}

export function bakedBuild(): ServiceBuild {
  const commit = process.env.ODU_COMMIT_HASH?.trim();
  const buildId = process.env.ODU_BUILD_ID?.trim();
  return {
    oduVersion: ODU_VERSION,
    commit: commit === undefined || commit === "" ? null : commit,
    buildId: buildId === undefined || buildId === "" ? null : buildId,
    self: process.env.ODU_SELF ?? null,
  };
}

export function assertPackaged(env: NodeJS.ProcessEnv = process.env): void {
  const missing = (
    ["ODU_SELF", "ODU_WEB_DIST", "ODU_BUILD_ID", "ODU_OSFACTS_BIN"] as const
  ).filter(
    (key) => {
      const value = env[key];
      return value === undefined || value.trim() === "";
    },
  );
  if (missing.length === 0) return;
  throw new Error(
    `odu: this is not a complete odu package — ${missing.join(", ")} ` +
      `${missing.length === 1 ? "is" : "are"} unset. The Nix wrapper bakes ` +
      "every one of them (see default.nix); nothing sets them at runtime and " +
      "odu will not guess. Run odu from its Nix package: " +
      "`nix run github:juspay/odu -- …`, or `nix run . -- …` in a checkout.",
  );
}

/**
 * Start the daemon so it OUTLIVES this process.
 *
 * The framework's own survivable-spawn driver, not a bare `detached: true`:
 * under cgroup-v2 a detached child does not survive its session, so the driver
 * re-launches into its own transient user service where one is available and
 * falls back to a detached process group where it is not.
 */
export function spawnWebDaemon(): Effect.Effect<void, Error> {
  const packaged = Effect.try({
    try: () => {
      assertPackaged();
      return process.env.ODU_SELF as string;
    },
    catch: (err) => err as Error,
  });
  return Effect.flatMap(packaged, (self) => spawnAs(self));
}

function spawnAs(self: string): Effect.Effect<void, Error> {
  const plan = survivableSpawnPlan(process.env, process.platform, "odu-web");
  return survivableSpawnDriver(
    webDaemonSpawnConfig(self, plan, process.env, webHome().dir),
  ).spawn;
}

export function webDaemonSpawnConfig(
  self: string,
  plan: ReturnType<typeof survivableSpawnPlan>,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): Parameters<typeof survivableSpawnDriver>[0] {
  return {
    binPath: self,
    args: ["web-daemon"],
    // On the systemd branch this OVERLAYS the transient unit's manager env via
    // `--setenv`; on the detached branch it is the COMPLETE child env, with no
    // parent layered under it. Either way it must name everything odu reads.
    env: daemonEnv(env),
    unitPrefix: "odu-web",
    ...(plan.mechanism === "detached"
      ? { fromSource: { inheritParentEnv: false } as const }
      : {}),
    // Nobody holds a detached child's stderr, so a daemon that dies before it
    // can log has nowhere to say why. Under systemd the unit's own journal has
    // it and the driver ignores this.
    stderrLog: webStderrLog(homeDir).path,
  };
}

export interface StderrLog {
  readonly path: string;
  tail(): string | null;
}

export function webStderrLog(homeDir: string): StderrLog {
  const path = join(homeDir, "web-daemon.stderr.log");
  return {
    path,
    tail: () => {
      try {
        const said = readFileSync(path, "utf-8").trimEnd().slice(-2_000);
        return said === "" ? null : said;
      } catch {
        return null;
      }
    },
  };
}

const DAEMON_ONLY_ENV_KEYS = [
  "ODU_OSFACTS_BIN",
  "ODU_WEB_ORIGIN",
  "ODU_WEB_DIST",
  "ODU_WEB_ALLOWED_ORIGINS",
  "ODU_WEB_MCP_TOKEN",
  "ODU_COMMIT_HASH",
  "ODU_BUILD_ID",
  "ODU_ROOT_TOKEN",
  "ODU_CACHE_STORE",
  "ODU_OBJECT_STORES",
  "ODU_PUBLIC_ORIGIN",
] as const;

export function daemonEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return pickEnv(source, [...ODU_CHILD_ENV_KEYS, ...DAEMON_ONLY_ENV_KEYS]);
}
