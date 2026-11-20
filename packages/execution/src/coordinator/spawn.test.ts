import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { survivableSpawnDriver } from "@kolu/surface-daemon-supervisor";
import {
  busSocketPath,
  coordinatorSpawnConfig,
  coordinatorSpawnSpec,
  withSameDir,
  oduSelfArgv,
  type SpawnEnv,
  type SpawnPlan,
  survivableSpawnPlan,
  userManagerReachable,
} from "./spawn";

const UNIT = "odu-run-0000000a-0001";
const ODU_ARGV = ["odu", "run", "e2e"];

function launched(
  env: SpawnEnv,
  oduArgv: readonly string[] = ODU_ARGV,
  unit = UNIT,
  platform: NodeJS.Platform = "linux",
): { command: string; args: string[] } {
  const plan: SpawnPlan = survivableSpawnPlan(env, platform, unit, HAS_BUS);
  let seen: { command: string; args: string[] } | undefined;
  Effect.runSync(
    survivableSpawnDriver(coordinatorSpawnConfig(oduArgv, env, plan, unit), {
      env: env as Record<string, string | undefined>,
      unitSuffix: () => "suffix",
      spawnProcess: (command, args) => {
        seen = { command, args };
        return { unref: () => {} };
      },
    }).spawn,
  );
  if (seen === undefined) throw new Error("the driver never spawned anything");
  return seen;
}

const HAS_BUS = (env: SpawnEnv): boolean =>
  userManagerReachable(env, () => true);

function plan(env: SpawnEnv, platform: NodeJS.Platform = "linux") {
  return survivableSpawnPlan(env, platform, UNIT, HAS_BUS);
}

describe("the spawn plan off linux", () => {
  it("is detached on darwin, and says systemd is not there", () => {
    const p = plan(
      { INVOCATION_ID: "abc", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus" },
      "darwin",
    );
    expect(p.mechanism).toBe("detached");
    expect(p.reason).toContain("no systemd");
    expect(p.reason).toContain("darwin");
    const { command, args } = launched(
      { INVOCATION_ID: "abc", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus" },
      ODU_ARGV,
      UNIT,
      "darwin",
    );
    expect([command, ...args]).toEqual(ODU_ARGV);
  });

  it("is detached on win32 too, by the same rule", () => {
    expect(plan({ INVOCATION_ID: "abc" }, "win32").mechanism).toBe("detached");
  });
});

describe("the spawn plan on linux", () => {
  it("is detached outside a unit, because there is no cgroup to escape", () => {
    const p = plan({});
    expect(p.mechanism).toBe("detached");
    expect(p.reason).toContain("not running under a systemd unit");
    const { command, args } = launched({});
    expect([command, ...args]).toEqual(ODU_ARGV);
  });

  it("uses systemd-run inside a unit that has a session bus", () => {
    const p = plan({
      INVOCATION_ID: "9d7a",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
    expect(p.mechanism).toBe("systemd-run");
    expect(p.reason).toContain(UNIT);

    const { command, args } = launched({
      INVOCATION_ID: "9d7a",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
    expect(command).toBe("systemd-run");
    expect(args[0]).toBe("--user");
    expect(args.slice(-ODU_ARGV.length)).toEqual(ODU_ARGV);
    expect(args).toContain("--unit");
    expect(args.some((a) => a.startsWith(UNIT))).toBe(true);
    expect(args).toContain("--collect");
  });

  it("accepts XDG_RUNTIME_DIR alone as evidence of a user manager", () => {
    const p = plan({ INVOCATION_ID: "9d7a", XDG_RUNTIME_DIR: "/run/user/1000" });
    expect(p.mechanism).toBe("systemd-run");
  });

  it("admits the honest limit when a unit has no reachable user manager", () => {
    const p = plan({ INVOCATION_ID: "9d7a" });
    expect(p.mechanism).toBe("detached");
    expect(p.reason).toContain("no user session bus is reachable");
    expect(p.reason).toContain("a restart of it will kill the run");
  });

  it("takes the opt-out over everything else that is true", () => {
    const p = plan({
      ODU_NO_SYSTEMD_RUN: "1",
      INVOCATION_ID: "9d7a",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    expect(p.mechanism).toBe("detached");
    expect(p.reason).toContain("ODU_NO_SYSTEMD_RUN");
    const { command, args } = launched({
      ODU_NO_SYSTEMD_RUN: "1",
      INVOCATION_ID: "9d7a",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    expect([command, ...args]).toEqual(ODU_ARGV);
  });
});

describe("empty strings", () => {
  it("read as unset at every variable the decision turns on", () => {
    expect(
      plan({ INVOCATION_ID: "", DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" })
        .reason,
    ).toContain("not running under a systemd unit");

    expect(
      plan({
        ODU_NO_SYSTEMD_RUN: "",
        INVOCATION_ID: "9d7a",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/x",
      }).mechanism,
    ).toBe("systemd-run");

    expect(
      plan({
        INVOCATION_ID: "9d7a",
        DBUS_SESSION_BUS_ADDRESS: "",
        XDG_RUNTIME_DIR: "",
      }).reason,
    ).toContain("no user session bus is reachable");
  });
});

describe("oduSelfArgv", () => {
  it("is exactly the wrapper path when the nix wrapper baked one in", () => {
    expect(oduSelfArgv({ ODU_SELF: "/nix/store/x/bin/odu" })).toEqual([
      "/nix/store/x/bin/odu",
    ]);
  });

  it("REFUSES when the wrapper baked nothing — a misbuilt package, not a mode", () => {
    expect(() => oduSelfArgv({})).toThrow(/ODU_SELF is unset/);
    expect(() => oduSelfArgv({ ODU_SELF: "" })).toThrow(/misbuilt package/);
  });
});

describe("coordinatorSpawnSpec", () => {
  it("detaches into its own process group and pipes the child's early output", () => {
    const spec = coordinatorSpawnSpec("/checkouts/odu");
    expect(spec.cwd).toBe("/checkouts/odu");
    expect(spec.detached).toBe(true);
    expect(spec.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });
});

describe("the bus is a SOCKET, not a variable", () => {
  it("refuses a named bus whose socket is not there", () => {
    const looked: string[] = [];
    const reachable = userManagerReachable(
      { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
      (path) => {
        looked.push(path);
        return false;
      },
    );
    expect(reachable).toBe(false);
    expect(looked).toEqual(["/run/user/1000/bus"]);
  });

  it("looks under XDG_RUNTIME_DIR when no address names a path", () => {
    const looked: string[] = [];
    userManagerReachable({ XDG_RUNTIME_DIR: "/run/user/1000" }, (path) => {
      looked.push(path);
      return true;
    });
    expect(looked).toEqual(["/run/user/1000/bus"]);
  });

  it("has nowhere to look when neither variable is set", () => {
    expect(userManagerReachable({}, () => true)).toBe(false);
  });

  it("reads an address that names no path as naming none", () => {
    expect(busSocketPath("unix:abstract=/tmp/dbus-abc")).toBeNull();
    expect(busSocketPath("unix:path=/run/user/1000/bus,guid=deadbeef")).toBe(
      "/run/user/1000/bus",
    );
  });

  it("takes the detached branch, with the honest reason, when nothing answers", () => {
    const p = survivableSpawnPlan(
      { INVOCATION_ID: "9d7a", XDG_RUNTIME_DIR: "/run/user/1000" },
      "linux",
      UNIT,
      () => false,
    );
    expect(p.mechanism).toBe("detached");
    expect(p.reason).toContain("no user session bus is reachable");
  });
});

describe("what a spawned process EXITING means", () => {
  it("is death for a detached spawn — that process IS the coordinator", () => {
    const plan = survivableSpawnPlan({}, "linux", "odu-run-x");
    expect(plan.mechanism).toBe("detached");
    expect(plan.exitIsDeath).toBe(true);
    expect(plan.describeExit(1)).toContain("coordinator exited 1");
  });

  it("is NOT death for systemd-run — it only submitted the unit", () => {
    const plan = survivableSpawnPlan(
      { INVOCATION_ID: "abc", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus" },
      "linux",
      "odu-run-x",
      HAS_BUS,
    );
    expect(plan.mechanism).toBe("systemd-run");
    expect(plan.exitIsDeath).toBe(false);
    expect(plan.describeExit(0)).toContain("accepted the unit");
    expect(plan.describeExit(1)).toContain("refused");
  });
});

describe("a transient unit is told where odu keeps its things", () => {
  it("forwards the variables odu itself reads", () => {
    const { args } = launched(
      {
        INVOCATION_ID: "abc",
        XDG_RUNTIME_DIR: "/run/user/1000",
        ODU_HOSTS: "/etc/odu/hosts.json",
        ODU_STATE_DIR: "/state/odu",
        ODU_SNAPSHOT_TRANSPORT: "always",
        ODU_SNAPSHOT_MAX_BYTES: "1024",
        SURFACE_AGENT_FLAKE_REF: "/nix/store/abc-odu-agent-flake-source",
      },
      ["odu", "run"],
      "odu-run-7",
    );

    expect(args).toContain("--setenv");
    expect(args).toContain("ODU_HOSTS=/etc/odu/hosts.json");
    expect(args).toContain("ODU_STATE_DIR=/state/odu");
    expect(args).toContain("ODU_SNAPSHOT_TRANSPORT=always");
    expect(args).toContain("ODU_SNAPSHOT_MAX_BYTES=1024");
    expect(args).toContain(
      "SURFACE_AGENT_FLAKE_REF=/nix/store/abc-odu-agent-flake-source",
    );
    expect(args).toContain("XDG_RUNTIME_DIR=/run/user/1000");
    expect(args.lastIndexOf("--setenv")).toBeLessThan(args.indexOf("odu"));
    expect(args.slice(-2)).toEqual(["odu", "run"]);
  });

  it("names only what it means to, and skips what is unset", () => {
    const { args } = launched(
      {
        INVOCATION_ID: "abc",
        XDG_RUNTIME_DIR: "/run/user/1000",
        ODU_HOSTS: "",
        CLAUDE_CODE_CHILD_SESSION: "leak-me",
      },
      ["odu", "run"],
      "odu-run-7",
    );

    expect(args.join(" ")).not.toContain("CLAUDE_CODE_CHILD_SESSION");
    expect(args.join(" ")).not.toContain("ODU_HOSTS=");
  });
});

describe("the working directory a daemon does not need", () => {
  it("inserts --same-dir directly after the --user the driver leads with", () => {
    expect(
      withSameDir("systemd-run", ["--user", "--collect", "--unit", "u", "odu"]),
    ).toEqual(["--user", "--same-dir", "--collect", "--unit", "u", "odu"]);
  });

  it("REFUSES an argv whose shape it does not recognise", () => {
    expect(() => withSameDir("systemd-run", ["--collect", "--user"])).toThrow(
      /no longer being set/,
    );
    expect(() => withSameDir("nsenter", ["--user"])).toThrow(/changed shape/);
  });
});
