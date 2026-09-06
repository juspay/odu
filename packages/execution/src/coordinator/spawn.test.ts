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
 * branch's real syscalls are exercised by `packages/cli/src/mcp/spawnSurvival.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { survivableSpawnDriver } from "@kolu/surface-daemon-supervisor";
import {
  coordinatorSpawnConfig,
  coordinatorSpawnSpec,
  withSameDir,
  oduSelfArgv,
  type SpawnEnv,
  type SpawnPlan,
  survivableSpawnPlan,
} from "./spawn";

const UNIT = "odu-run-0000000a-0001";
const ODU_ARGV = ["odu", "run", "e2e"];

/**
 * The argv that WOULD be executed, without executing it.
 *
 * odu no longer assembles this: the `systemd-run` incantation is
 * `@kolu/surface-daemon-supervisor`'s `survivableSpawnDriver`, and what odu
 * supplies is `coordinatorSpawnConfig`. So the assertions below run the real
 * driver over odu's real config with the fork replaced by a capture — which
 * makes them a test of the COMPOSITION odu actually ships rather than of a
 * private copy of the mechanism. A capture that never fires is a test that
 * asserted nothing, so `launched` throws rather than returning empty.
 */
function launched(
  env: SpawnEnv,
  oduArgv: readonly string[] = ODU_ARGV,
  unit = UNIT,
  platform: NodeJS.Platform = "linux",
): { command: string; args: string[] } {
  const plan: SpawnPlan = survivableSpawnPlan(env, platform, unit);
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
    // The odu argv is the TAIL, unmodified: the wrapper prepends, it never
    // rewrites what it was asked to run.
    expect(command).toBe("systemd-run");
    expect(args[0]).toBe("--user");
    expect(args.slice(-ODU_ARGV.length)).toEqual(ODU_ARGV);
    // Scoped to the run, so two coordinators never collide on a unit name and
    // `systemctl --user status` names the run an operator is asking about. The
    // driver appends a per-spawn suffix, because a dead unit can linger loaded
    // and refuse a name that is reused.
    expect(args).toContain("--unit");
    expect(args.some((a) => a.startsWith(UNIT))).toBe(true);
    // Reap the unit's own bookkeeping, so a machine that runs a hundred CI runs
    // does not accumulate a hundred failed unit stubs.
    expect(args).toContain("--collect");
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
    // And the driver is TOLD, not left to re-derive: every systemd marker here
    // is set, so a second decision inside the driver would take the other
    // branch. One decision, forced across.
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

describe("what a spawned process EXITING means", () => {
  // The distinction a false refusal turns on. `systemd-run --user` is a
  // SUBMITTER: it asks the user manager to start a transient unit and exits as
  // soon as the job is accepted, normally while the service is still starting.
  // A readiness wait that treated that exit as the coordinator's would give up
  // on a run that is coming up perfectly well, report a failure, and leave the
  // run executing with nobody watching it.
  it("is death for a detached spawn — that process IS the coordinator", () => {
    const plan = survivableSpawnPlan({}, "linux", "odu-run-x");
    expect(plan.mechanism).toBe("detached");
    expect(plan.exitIsDeath).toBe(true);
    expect(plan.describeExit(1)).toContain("coordinator exited 1");
  });

  it("is NOT death for systemd-run — it only submitted the unit", () => {
    const plan = survivableSpawnPlan(
      { INVOCATION_ID: "abc", DBUS_SESSION_BUS_ADDRESS: "unix:/run/bus" },
      "linux",
      "odu-run-x",
    );
    expect(plan.mechanism).toBe("systemd-run");
    expect(plan.exitIsDeath).toBe(false);
    // Zero says the job was accepted and nothing about the service…
    expect(plan.describeExit(0)).toContain("accepted the unit");
    // …non-zero says the manager refused it, which IS a failure.
    expect(plan.describeExit(1)).toContain("refused");
  });
});

describe("a transient unit is told where odu keeps its things", () => {
  // A transient unit starts from the user manager's environment, not from the
  // launcher's. Everything that tells odu where to look is simply ABSENT
  // unless it is named — and a coordinator that starts with no hosts file and
  // no state root is not a coordinator that started.
  it("forwards the variables odu itself reads", () => {
    const { args } = launched(
      {
        INVOCATION_ID: "abc",
        XDG_RUNTIME_DIR: "/run/user/1000",
        ODU_HOSTS: "/etc/odu/hosts.json",
        ODU_STATE_DIR: "/state/odu",
        ODU_RUNNER_FLAKE: "git+file:///src/odu",
      },
      ["odu", "run"],
      "odu-run-7",
    );

    expect(args).toContain("--setenv");
    expect(args).toContain("ODU_HOSTS=/etc/odu/hosts.json");
    expect(args).toContain("ODU_STATE_DIR=/state/odu");
    expect(args).toContain("ODU_RUNNER_FLAKE=git+file:///src/odu");
    // The runtime dir decides where a socket may live, so it travels too.
    expect(args).toContain("XDG_RUNTIME_DIR=/run/user/1000");
    // Every `--setenv` precedes the payload.
    expect(args.lastIndexOf("--setenv")).toBeLessThan(args.indexOf("odu"));
    expect(args.slice(-2)).toEqual(["odu", "run"]);
  });

  it("names only what it means to, and skips what is unset", () => {
    // An allowlist, not the whole environment: forwarding a launcher's entire
    // environment into a service is how an orchestrator's ambient identity
    // variables end up inside every recipe the run executes.
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
    // An empty value is unset, not an empty assignment.
    expect(args.join(" ")).not.toContain("ODU_HOSTS=");
  });
});

describe("the working directory a daemon does not need", () => {
  // A run is a function of its CHECKOUT, so a coordinator must start there.
  // kolu's driver takes no `cwd` — a surface daemon has no such tie — so the
  // detached branch gets one at odu's spawn seam and the systemd branch gets
  // `--same-dir` inserted into the argv the driver assembled.
  it("inserts --same-dir directly after the --user the driver leads with", () => {
    expect(
      withSameDir("systemd-run", ["--user", "--collect", "--unit", "u", "odu"]),
    ).toEqual(["--user", "--same-dir", "--collect", "--unit", "u", "odu"]);
  });

  it("REFUSES an argv whose shape it does not recognise", () => {
    // The failure this guard exists for is silent and distant: a coordinator
    // started in the user manager's directory cannot find the justfile it was
    // asked to run, and the error names a missing recipe rather than a missing
    // flag. If a future driver stops leading with `--user`, fail HERE.
    expect(() => withSameDir("systemd-run", ["--collect", "--user"])).toThrow(
      /no longer being set/,
    );
    expect(() => withSameDir("nsenter", ["--user"])).toThrow(/changed shape/);
  });
});
