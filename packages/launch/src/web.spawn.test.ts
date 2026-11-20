import { describe, expect, it } from "bun:test";
import { survivableSpawnPlan } from "@odu/execution/coordinator/spawn";
import { assertPackaged, bakedBuild, daemonEnv, webDaemonSpawnConfig } from "./webDaemonLaunch";

const SELF = "/nix/store/x/bin/odu";
const HOME_DIR = "/home/dev/.local/state/odu-web";

const underSystemd = survivableSpawnPlan(
  {
    INVOCATION_ID: "9d7a",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  },
  "linux",
  "odu-web",
  () => true,
);

const bareShell = survivableSpawnPlan({}, "linux", "odu-web");

describe("the daemon's launch mode", () => {
  it("takes the systemd branch inside a unit, so the daemon leaves its cgroup", () => {
    const config = webDaemonSpawnConfig(SELF, underSystemd, {}, HOME_DIR);
    expect(config.fromSource).toBeUndefined();
    expect(config.unitPrefix).toBe("odu-web");
    expect(config.binPath).toBe(SELF);
    expect(config.args).toEqual(["web-daemon"]);
  });

  it("forces the detached branch outside one, and inherits NOTHING", () => {
    const config = webDaemonSpawnConfig(SELF, bareShell, {}, HOME_DIR);
    expect(config.fromSource).toEqual({ inheritParentEnv: false });
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
      SURFACE_AGENT_FLAKE_REF: "/nix/store/abc-odu-agent-flake-source",
    });
    expect(env).toEqual({
      ODU_STATE_DIR: "/state",
      ODU_SELF: SELF,
      ODU_HOSTS: "/hosts.json",
      ODU_WEB_ORIGIN: "http://127.0.0.1:18441",
      SURFACE_AGENT_FLAKE_REF: "/nix/store/abc-odu-agent-flake-source",
    });
  });

  it("carries the cache's two settings, and no further", () => {
    const env = daemonEnv({
      ODU_ROOT_TOKEN: "root-secret",
      ODU_CACHE_STORE: "local?root=/tmp/chroot",
      ODU_PUBLIC_ORIGIN: "https://cache.example.com",
    });
    expect(env.ODU_ROOT_TOKEN).toBe("root-secret");
    expect(env.ODU_CACHE_STORE).toBe("local?root=/tmp/chroot");
    expect(env.ODU_PUBLIC_ORIGIN).toBe("https://cache.example.com");
    expect(daemonEnv({ ODU_ROOT_TOKEN: "" }).ODU_ROOT_TOKEN).toBeUndefined();
  });

  it("carries what a COORDINATOR it starts will need", () => {
    const env = daemonEnv({
      HOME: "/home/dev",
      PATH: "/usr/bin",
      TMPDIR: "/tmp/x",
      NIX_PATH: "nixpkgs=/nix/store/p",
      NIX_SSL_CERT_FILE: "/etc/ssl/certs/ca-bundle.crt",
      LOCALE_ARCHIVE: "/nix/store/l/lib/locale/locale-archive",
      XDG_RUNTIME_DIR: "/run/user/1000",
      SURFACE_AGENT_FLAKE_REF: "/nix/store/abc-odu-agent-flake-source",
    });
    for (const key of [
      "HOME",
      "PATH",
      "TMPDIR",
      "NIX_PATH",
      "NIX_SSL_CERT_FILE",
      "LOCALE_ARCHIVE",
      "XDG_RUNTIME_DIR",
      "SURFACE_AGENT_FLAKE_REF",
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
    expect(() => assertPackaged({})).toThrow(
      /ODU_SELF, ODU_WEB_DIST, ODU_BUILD_ID, ODU_OSFACTS_BIN/,
    );
  });
});

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
    expect(build).toMatchObject({ buildId: null, commit: null, self: null });
  });
});
