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
import { daemonEnv, webDaemonSpawnConfig } from "./web";

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
