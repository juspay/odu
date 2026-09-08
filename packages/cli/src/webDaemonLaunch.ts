/**
 * HOW A CLIENT STARTS THE DAEMON — the leaf both sides of the singleton stand on.
 *
 * Every one of these used to live in `./web`, next to the server, and that
 * colocation was the thing standing between odu and a bootstrap seam. A thin
 * client — `odu surface`, the `odu mcp` bridge, any public command — that
 * reached for `webHome` or `bakedBuild` to converge on the singleton would have
 * pulled `createOduService`, `serveSurfaceApp` and, through `./webPorts`, the
 * whole execution engine into its module graph: the entire server, imported so
 * that a client could learn where a gate file is. Worse, `./serviceMcp`
 * reaching for them would have closed a real `web.ts → serviceMcp.ts → web.ts`
 * ESM cycle that no closure test polices — the package walls are package-level,
 * and a cycle inside one is invisible to them.
 *
 * So the five facts a LAUNCHER needs are here, and they are only facts:
 *
 *   - where this service's home is, derived from its origin ({@link webHome});
 *   - which application this is ({@link bakedBuild});
 *   - whether this is a complete package at all ({@link assertPackaged});
 *   - the environment a daemon must run with ({@link daemonEnv});
 *   - how to start one so it outlives the caller ({@link spawnWebDaemon}).
 *
 * Nothing here serves anything. `./web` imports this and adds the serving;
 * `./webLauncher` imports it and adds the converging. Neither imports the other.
 */

import { join } from "node:path";
import { createHash } from "node:crypto";
import { daemonHome } from "@kolu/surface-daemon";
import { survivableSpawnDriver } from "@kolu/surface-daemon-supervisor";
import {
  ODU_CHILD_ENV_KEYS,
  pickEnv,
  survivableSpawnPlan,
} from "@odu/execution/coordinator/spawn";
import { ODU_VERSION } from "@odu/execution/common/version";
import {
  DEFAULT_SERVICE_ORIGIN,
  SERVICE_APP,
  serviceOrigin,
} from "@odu/service-client/endpoint";
import type { ServiceBuild } from "@odu/service-client/surface";
import { Effect } from "effect";

/** Where the browser bundle lives. Baked by the Nix wrapper, and REQUIRED: a
 *  service without a page is a misbuilt package, not a mode ({@link
 *  assertPackaged}). */
const DIST_ENV = "ODU_WEB_DIST";

/**
 * ONE GATE PER ADDRESS.
 *
 * `ODU_WEB_ORIGIN` is documented as moving the whole service, so a developer
 * can run a second odu against a scratch catalog. It moved the address and not
 * the gate: both services computed `~/.local/state/odu-web/`, so the second one
 * read a live holder there and yielded — to a daemon serving a different port
 * and a different catalog. A singleton is per-address or it is not a singleton,
 * and the two spellings of "which service am I" have to be one.
 *
 * The default origin keeps the plain namespace, so nothing about an ordinary
 * install moves. Any other origin gets its own, named by a digest of the origin
 * rather than by the port alone — `http://127.0.0.1:9000` and
 * `http://[::1]:9000` are two addresses.
 */
export function webAppNamespace(origin: string): string {
  if (origin === DEFAULT_SERVICE_ORIGIN) return SERVICE_APP;
  const digest = createHash("sha256").update(origin).digest("hex").slice(0, 12);
  return `${SERVICE_APP}-${digest}`;
}

/** The daemon's own home — the same call the launcher makes, so the two cannot
 *  disagree about where the gate and the control socket are. */
export function webHome(
  origin: string = serviceOrigin(),
): ReturnType<typeof daemonHome> {
  return daemonHome({ app: webAppNamespace(origin), placement: "state" });
}

/**
 * WHICH BUILD this is — an identity, and separately a provenance.
 *
 * These used to be baked together or not at all, on the framework's rule that
 * "a Nix build id means the source commit was knowable". That rule is wrong
 * here, and the way it was wrong mattered: `nix build .#odu` on a dirty tree
 * produces a complete, hash-identified package with no navigable commit, and
 * treating it as having NO identity made `ensureService`'s compatible-reuse
 * branch permanently dead on every developer machine and every local e2e run —
 * the singleton's most-used decision, dark exactly where it was most exercised.
 *
 * So they are two axes now:
 *
 *   - `buildId` is WHICH APPLICATION, the wrapper derivation's own store path.
 *     Always present in a Nix build, dirty or not. Match-only, never ordered —
 *     store hashes do not order.
 *   - `commit` is WHERE IT CAME FROM, optional, and only for a reader that
 *     wants to navigate to a forge.
 *
 * A missing `buildId` is therefore not "off-nix" but a MISBUILT package, and
 * {@link assertPackaged} says so rather than letting it read as anonymity.
 */
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

/**
 * THE PACKAGED CONTRACT, asserted where it is first relied on.
 *
 * Nix is odu's only supported runtime, and the wrapper is what makes that true:
 * it bakes odu's own absolute path, the browser bundle, and this build's
 * identity. Every one of those used to have a runtime repair beside it — an
 * interpreter path guessed from `process.argv`, a service that served its wire
 * and 404'd its page, an identity that quietly went null — and each repair
 * turned a packaging defect into a subtly degraded application that looked like
 * a mode somebody had chosen.
 *
 * They are gone, and this is what replaced them: one refusal, naming the
 * variable, at the point the service is about to serve. A misbuilt package
 * fails loudly and immediately rather than half-working for as long as nobody
 * opens the browser.
 */
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
 *
 * **WHICH branch is odu's decision, not the driver's**, and it is the same
 * decision a coordinator gets. The driver's own gate is `INVOCATION_ID`;
 * {@link survivableSpawnPlan} is richer — it honours `ODU_NO_SYSTEMD_RUN` and
 * probes for a session bus that actually exists — so it decides and the driver
 * is told, exactly as `@odu/execution`'s `coordinatorSpawnConfig` does. Passing
 * `fromSource` unconditionally, as this used to, forced the detached branch
 * even inside a systemd service, where detaching escapes nothing: the daemon
 * stays in the launching unit's cgroup and dies with it, having promised the
 * opposite.
 *
 * `inheritParentEnv` is FALSE on that branch. This is a packaged launch — the
 * binary is a Nix wrapper that carries its own environment — so the child needs
 * {@link daemonEnv} and nothing layered under it. The opposite is what a
 * coordinator needs, and the two differ for a reason: a coordinator is a
 * developer's shell made durable, a daemon must not inherit an orchestrator's
 * ambient identity and pass it to every run it later starts.
 */
export function spawnWebDaemon(): Effect.Effect<void, Error> {
  // A packaging error, not a mode. There is no hand-start to fall back to:
  // `bun src/main.ts web-daemon` was never a supported way to run odu, and
  // suggesting it papered over exactly the defect this now names.
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

/**
 * The four values odu supplies to the framework's mechanism, plus the launch
 * mode. Pure and exported for the same reason `coordinatorSpawnConfig` is: this
 * is the WHOLE of odu's contribution to how the daemon starts, and it is what a
 * suite can pin on a machine with no systemd.
 */
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
    // parent layered under it. Either way it must name everything odu reads,
    // which is why the list below is long rather than clever.
    env: daemonEnv(env),
    unitPrefix: "odu-web",
    ...(plan.mechanism === "detached"
      ? { fromSource: { inheritParentEnv: false } as const }
      : {}),
    // Nobody holds a detached child's stderr, so a daemon that dies before it
    // can log has nowhere to say why. Under systemd the unit's own journal has
    // it and the driver ignores this.
    stderrLog: webStderrLog(homeDir),
  };
}

/**
 * Where a spawned daemon's crash catcher lives.
 *
 * Exported, and named once, because two sides depend on it being the same file:
 * this module tells the spawn driver where to WRITE, and `./webLauncher` reads
 * it to explain a daemon that never answered. Those were two string literals
 * with a comment between them asking that they stay equal — which is a wish
 * rather than a mechanism, and the failure it invites is the worst-shaped one
 * available: a launcher reporting silence from a daemon that said exactly why
 * it died.
 */
export function webStderrLog(homeDir: string): string {
  return join(homeDir, "web-daemon.stderr.log");
}

/**
 * What only the WEB daemon needs, on top of what every odu child needs.
 *
 * Four locators for the service itself and the pair that names this build. A
 * coordinator has no use for any of them, which is why they are here and not in
 * `ODU_CHILD_ENV_KEYS`.
 */
const WEB_DAEMON_ENV_KEYS = [
  // The gate reader's binary. Here rather than in `ODU_CHILD_ENV_KEYS` because
  // claiming a pid gate is the DAEMON's act — `claimPidGate` and `daemonMain`
  // appear nowhere else — and a coordinator claims none.
  "ODU_OSFACTS_BIN",
  "ODU_WEB_ORIGIN",
  "ODU_WEB_DIST",
  "ODU_WEB_ALLOWED_ORIGINS",
  "ODU_WEB_MCP_TOKEN",
  "ODU_COMMIT_HASH",
  "ODU_BUILD_ID",
] as const;

/**
 * The env a daemon runs with, named rather than inherited wholesale.
 *
 * On the detached branch this is the COMPLETE environment, and this daemon's
 * job includes starting coordinators that shell out to `nix` and `git` — so
 * anything they need has to be named or the failure appears four layers away,
 * as a run that will not provision, in a process nobody is watching. That is
 * not hypothetical: it is what happened, and it happened because this list and
 * the coordinator's were two lists. There is one now
 * ({@link ODU_CHILD_ENV_KEYS}), and this adds only what is genuinely the web
 * face's.
 */
export function daemonEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return pickEnv(source, [...ODU_CHILD_ENV_KEYS, ...WEB_DAEMON_ENV_KEYS]);
}
