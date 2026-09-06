/**
 * Which independence a coordinator actually gets, and the sentence that says so.
 *
 * `survivableSpawnPlan` decides between two very different promises — "your run
 * is in a cgroup of its own" and "your run dies when this unit restarts" — from
 * three environment variables and a platform. That decision is easy to get
 * wrong in the direction that is invisible: reaching for `systemd-run` where
 * there is no user manager fails at spawn time on someone else's machine, and
 * NOT reaching for it inside a unit silently hands back a run that a `systemctl
 * restart` will kill while the receipt claims it survives.
 *
 * So the function is pure — every input is an argument — and this file states
 * WORLDS rather than mutating the process's own environment. What is pinned:
 *
 *   - the mechanism for each world, including every "empty string means unset"
 *     boundary, since a shell exporting an empty `INVOCATION_ID` is a real
 *     spelling of "not under a unit";
 *   - the argv `systemd-run` actually gets, as a token array whose tail is the
 *     odu argv unchanged;
 *   - the HONEST LIMIT sentence — the one case where odu cannot escape the
 *     cgroup and says so. That sentence is the whole value of the branch: an
 *     operator is entitled to know before the run does.
 *
 * `systemd-run` itself is NOT executed here, and cannot be: the Nix build
 * sandbox and the CI container have neither a user manager nor a session bus.
 * The module header says as much. This suite pins the DECISION; the detached
 * branch's real syscalls are exercised by `src/mcp/spawnSurvival.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import {
  coordinatorSpawnSpec,
  oduSelfArgv,
  type SpawnEnv,
  survivableSpawnPlan,
} from "./spawn";

const UNIT = "odu-run-0000000a-0001";
const ODU_ARGV = ["odu", "run", "e2e"];

/** A world, named. `platform` defaults to linux because every interesting
 *  branch is a linux branch. */
function plan(env: SpawnEnv, platform: NodeJS.Platform = "linux") {
  return survivableSpawnPlan(env, platform, UNIT);
}

describe("the spawn plan off linux", () => {
  it("is detached on darwin, and says systemd is not there", () => {
    // Even with every systemd marker set — an env inherited across an ssh hop,
    // say. The platform decides first: there is no user manager to ask.
    const p = plan(
      { INVOCATION_ID: "abc", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus" },
      "darwin",
    );
    expect(p.mechanism).toBe("detached");
    expect(p.reason).toContain("no systemd");
    expect(p.reason).toContain("darwin");
    // A detached plan runs the odu argv itself, unwrapped.
    expect(p.argv(ODU_ARGV)).toEqual(ODU_ARGV);
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
    expect(p.argv(ODU_ARGV)).toEqual(ODU_ARGV);
  });

  it("uses systemd-run inside a unit that has a session bus", () => {
    const p = plan({
      INVOCATION_ID: "9d7a",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    });
    expect(p.mechanism).toBe("systemd-run");
    expect(p.reason).toContain(UNIT);

    const argv = p.argv(ODU_ARGV);
    // A token array, and the odu argv is its TAIL, unmodified: the wrapper
    // prepends, it never rewrites what it was asked to run.
    expect(argv.slice(0, 2)).toEqual(["systemd-run", "--user"]);
    expect(argv.slice(-ODU_ARGV.length)).toEqual(ODU_ARGV);
    // Scoped to the run, so two coordinators never collide on a unit name and
    // `systemctl --user status` names the run an operator is asking about.
    expect(argv).toContain(`--unit=${UNIT}`);
    // `--` before the payload, so an odu flag can never be read as a
    // systemd-run flag.
    expect(argv.indexOf("--")).toBe(argv.length - ODU_ARGV.length - 1);
  });

  it("accepts XDG_RUNTIME_DIR alone as evidence of a user manager", () => {
    const p = plan({ INVOCATION_ID: "9d7a", XDG_RUNTIME_DIR: "/run/user/1000" });
    expect(p.mechanism).toBe("systemd-run");
  });

  it("admits the honest limit when a unit has no reachable user manager", () => {
    // The case odu cannot fix, so it names it. This sentence is what a launcher
    // reports as the run's lifetime, and "your run dies with this unit" is a
    // different promise from "your run survives it".
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
    expect(p.argv(ODU_ARGV)).toEqual(ODU_ARGV);
  });
});

describe("empty strings", () => {
  it("read as unset at every variable the decision turns on", () => {
    // A shell that exports a variable it never assigned sets it to "". Reading
    // that as "present" would flip all three decisions the wrong way.
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

  it("falls back to THIS runtime and entry, never a bare `bun` on a PATH", () => {
    // In a dev checkout the child must get the interpreter that is running us,
    // because whatever `bun` a spawned shell resolves is a different build.
    const argv = oduSelfArgv({});
    expect(argv.length).toBeGreaterThan(0);
    expect(argv[0]).toBe(process.execPath);
    // An empty ODU_SELF is unset here too.
    expect(oduSelfArgv({ ODU_SELF: "" })).toEqual(argv);
  });
});

describe("coordinatorSpawnSpec", () => {
  it("detaches into its own process group and pipes the child's early output", () => {
    // `detached` is what makes a signal addressed to the launcher's group miss
    // the coordinator; the pipes are how a caller reports a startup failure it
    // otherwise could only describe as "it did not come up".
    const spec = coordinatorSpawnSpec("/checkouts/odu");
    expect(spec.cwd).toBe("/checkouts/odu");
    expect(spec.detached).toBe(true);
    expect(spec.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });
});
