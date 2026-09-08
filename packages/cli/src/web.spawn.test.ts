/**
 * HOW `odu web` starts the daemon — which is a promise, not a detail.
 *
 * "It will outlive this shell" is printed to a person, and on cgroup-v2 it is
 * only true if the daemon leaves the launching unit's cgroup. A detached child
 * does NOT: `KillMode=control-group` walks cgroup membership, so stopping the
 * caller reaps it. Forcing the detached branch therefore does not merely lose an
 * optimisation — it makes the sentence false.
 *
 * That is exactly what `fromSource: { inheritParentEnv: true }` did here,
 * unconditionally, and it also layered the launcher's whole environment under
 * the allowlist that exists to stop precisely that. Both are pinned below.
 */

import { describe, expect, it } from "bun:test";
import { survivableSpawnPlan } from "@odu/execution/coordinator/spawn";
import { assertPackaged, bakedBuild, daemonEnv, webDaemonSpawnConfig } from "./web";

const SELF = "/nix/store/x/bin/odu";
const HOME_DIR = "/home/dev/.local/state/odu-web";

/** A world where a user manager is genuinely there. */
const underSystemd = survivableSpawnPlan(
  {
    INVOCATION_ID: "9d7a",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  },
  "linux",
  "odu-web",
  () => true,
);

/** A login shell: no unit, so nothing to escape. */
const bareShell = survivableSpawnPlan({}, "linux", "odu-web");

describe("the daemon's launch mode", () => {
  it("takes the systemd branch inside a unit, so the daemon leaves its cgroup", () => {
    const config = webDaemonSpawnConfig(SELF, underSystemd, {}, HOME_DIR);
    // ABSENT, which is what tells the driver this is a normal launch. Present —
    // as it used to be, always — forces the detached branch even here, where
    // detaching escapes nothing and the daemon dies with the caller's unit.
    expect(config.fromSource).toBeUndefined();
    expect(config.unitPrefix).toBe("odu-web");
    expect(config.binPath).toBe(SELF);
    expect(config.args).toEqual(["web-daemon"]);
  });

  it("forces the detached branch outside one, and inherits NOTHING", () => {
    const config = webDaemonSpawnConfig(SELF, bareShell, {}, HOME_DIR);
    expect(config.fromSource).toEqual({ inheritParentEnv: false });
    // `false`, not `true`. This is a PACKAGED launch: the binary is a Nix
    // wrapper carrying its own environment, so layering the launcher's under it
    // would only add an orchestrator's ambient identity — which then rides into
    // every run the daemon later starts.
  });

  it("wires a crash-catcher, because nobody holds a detached child's stderr", () => {
    const config = webDaemonSpawnConfig(SELF, bareShell, {}, HOME_DIR);
    expect(config.stderrLog).toBe(`${HOME_DIR}/web-daemon.stderr.log`);
  });
});

describe("the daemon's environment", () => {
  it("carries what odu itself reads", () => {
    const env = daemonEnv({
      ODU_STATE_DIR: "/state",
      ODU_SELF: SELF,
      ODU_HOSTS: "/hosts.json",
      ODU_WEB_ORIGIN: "http://127.0.0.1:18441",
      ODU_RUNNER_FLAKE: "github:juspay/odu",
    });
    expect(env).toEqual({
      ODU_STATE_DIR: "/state",
      ODU_SELF: SELF,
      ODU_HOSTS: "/hosts.json",
      ODU_WEB_ORIGIN: "http://127.0.0.1:18441",
      ODU_RUNNER_FLAKE: "github:juspay/odu",
    });
  });

  it("carries what a COORDINATOR it starts will need", () => {
    // The daemon's whole job includes spawning coordinators that shell out to
    // nix and git. On the detached branch this list is the complete child
    // environment, so anything missing here surfaces much later — as a run that
    // cannot provision, in a process nobody is watching.
    const env = daemonEnv({
      HOME: "/home/dev",
      PATH: "/usr/bin",
      TMPDIR: "/tmp/x",
      NIX_PATH: "nixpkgs=/nix/store/p",
      NIX_SSL_CERT_FILE: "/etc/ssl/certs/ca-bundle.crt",
      LOCALE_ARCHIVE: "/nix/store/l/lib/locale/locale-archive",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    for (const key of [
      "HOME",
      "PATH",
      "TMPDIR",
      "NIX_PATH",
      "NIX_SSL_CERT_FILE",
      "LOCALE_ARCHIVE",
      "XDG_RUNTIME_DIR",
    ]) {
      expect(env[key]).toBeDefined();
    }
  });

  it("leaves an orchestrator's ambient identity behind", () => {
    const env = daemonEnv({
      HOME: "/home/dev",
      CLAUDE_CODE_CHILD_SESSION: "abc",
      GITHUB_TOKEN: "ghp_secret",
      AWS_SECRET_ACCESS_KEY: "shh",
    });
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.HOME).toBe("/home/dev");
  });
});

/**
 * THE PACKAGED CONTRACT — the rule that replaced three runtime fallbacks.
 *
 * Nix is odu's only supported runtime. What used to happen when the wrapper had
 * not baked something was that odu repaired it: an interpreter path guessed
 * from `process.argv`, a service that bound its wire and 404'd its page, an
 * identity that quietly went null. Each repair turned a packaging defect into a
 * subtly degraded application that looked like a mode somebody had chosen, and
 * the degradation surfaced somewhere else entirely.
 */
describe("the packaged contract", () => {
  const COMPLETE = {
    ODU_SELF: SELF,
    ODU_WEB_DIST: "/nix/store/y-odu-web-ui",
    ODU_BUILD_ID: "/nix/store/z-odu",
    ODU_OSFACTS_BIN: "/nix/store/w-osfacts/bin/osfacts",
  };

  it("accepts a package that baked every locator", () => {
    expect(() => assertPackaged(COMPLETE)).not.toThrow();
  });

  it("names the MISSING variable, because that is the whole diagnosis", () => {
    for (const key of [
      "ODU_SELF",
      "ODU_WEB_DIST",
      "ODU_BUILD_ID",
      "ODU_OSFACTS_BIN",
    ] as const) {
      const partial = { ...COMPLETE, [key]: undefined };
      expect(() => assertPackaged(partial)).toThrow(new RegExp(key));
    }
  });

  it("reads an EMPTY value as unset — a wrapper is a thing somebody edits", () => {
    expect(() => assertPackaged({ ...COMPLETE, ODU_WEB_DIST: "  " })).toThrow(
      /ODU_WEB_DIST/,
    );
  });

  it("reports every missing locator at once, not the first one", () => {
    // A person fixing a wrapper wants the list. Reporting them one rebuild at a
    // time is three rebuilds to learn what one message could have said.
    expect(() => assertPackaged({})).toThrow(
      /ODU_SELF, ODU_WEB_DIST, ODU_BUILD_ID, ODU_OSFACTS_BIN/,
    );
  });
});

/**
 * IDENTITY AND PROVENANCE ARE TWO AXES, and conflating them broke the singleton.
 *
 * `ODU_BUILD_ID` and `ODU_COMMIT_HASH` used to be baked together or not at all,
 * on the framework's rule that "a Nix build id means the source commit was
 * knowable". A dirty tree still produces a complete, hash-identified Nix
 * package — so that build reported NO identity, `ensureService`'s `sameBuild`
 * was permanently false, and the compatible-reuse branch was dead on every
 * developer machine and every local e2e run.
 */
describe("bakedBuild", () => {
  const withEnv = <T,>(env: Record<string, string | undefined>, f: () => T): T => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
    }
    try {
      return f();
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };

  it("reports an identity for a build with NO navigable commit", () => {
    const build = withEnv(
      { ODU_BUILD_ID: "/nix/store/z-odu", ODU_COMMIT_HASH: undefined, ODU_SELF: SELF },
      bakedBuild,
    );
    expect(build.buildId).toBe("/nix/store/z-odu");
    // The dirty-tree case: a real package, honestly unable to name a commit.
    expect(build.commit).toBeNull();
    expect(build.self).toBe(SELF);
  });

  it("carries the commit as separate provenance when there is one", () => {
    const build = withEnv(
      { ODU_BUILD_ID: "/nix/store/z-odu", ODU_COMMIT_HASH: "abc123", ODU_SELF: SELF },
      bakedBuild,
    );
    expect(build).toMatchObject({ buildId: "/nix/store/z-odu", commit: "abc123" });
  });

  it("does not invent an identity when nothing was baked", () => {
    const build = withEnv(
      { ODU_BUILD_ID: undefined, ODU_COMMIT_HASH: undefined, ODU_SELF: undefined },
      bakedBuild,
    );
    // Null rather than a plausible blank — and `assertPackaged` is what turns
    // this into a refusal at the one place it matters.
    expect(build).toMatchObject({ buildId: null, commit: null, self: null });
  });
});
