import { describe, expect, it } from "bun:test";
import type { RunScope } from "@odu/run-history/schema";
import {
  coordinatorEnv,
  type LaunchRequest,
  launchArgv,
  mayRelaunchDetached,
  unitNameFor,
} from "./launcher";
import type { SpawnPlan } from "./spawn";

const RUN_ID = "0000000b-0002";
const PARENT = "0000000a-0001";
const SHA = "26d2c2dabcdef0123456789012345678901234ab";

function scope(over: Partial<RunScope> = {}): RunScope {
  return { selectors: ["e2e"], platforms: [], noDeps: false, ...over };
}

function request(over: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    checkout: "/checkouts/odu",
    runId: RUN_ID,
    parentRunId: null,
    requestId: null,
    scope: scope(),
    expectedSha: SHA,
    noStrict: false,
    noSnapshot: false,
    noPost: false,
    hostPins: [],
    hostsFile: null,
    actor: null,
    supersede: false,
    linger: false,
    push: null,
    pushSkipped: null,
    pushKeyWarning: null,
    checkoutMoved: null,
    ...over,
  };
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

describe("launchArgv", () => {
  it("always carries the minted run id and the commit being replayed", () => {
    const argv = launchArgv(request());
    expect(argv[0]).toBe("run-coordinator");
    expect(valueAfter(argv, "--run-id")).toBe(RUN_ID);
    expect(valueAfter(argv, "--expected-sha")).toBe(SHA);
  });

  it("emits the selectors, then one --platform per platform slice", () => {
    const argv = launchArgv(
      request({
        scope: scope({
          selectors: ["unit", "e2e"],
          platforms: ["x86_64-linux", "aarch64-darwin"],
        }),
      }),
    );
    expect(argv.slice(0, 3)).toEqual(["run-coordinator", "unit", "e2e"]);
    expect(argv.filter((a) => a === "--platform")).toHaveLength(2);
    expect(argv.slice(3, 7)).toEqual([
      "--platform",
      "x86_64-linux",
      "--platform",
      "aarch64-darwin",
    ]);
  });

  it("passes --root only when the recorded scope named one", () => {
    expect(launchArgv(request())).not.toContain("--root");
    const argv = launchArgv(request({ scope: scope({ root: "ci::default" }) }));
    expect(valueAfter(argv, "--root")).toBe("ci::default");
  });

  it("passes --no-deps only when the scope says the selectors ran alone", () => {
    expect(launchArgv(request())).not.toContain("--no-deps");
    expect(launchArgv(request({ scope: scope({ noDeps: true }) }))).toContain(
      "--no-deps",
    );
  });

  it("carries the strict-mode flags so a replay reproduces its parent", () => {
    const bare = launchArgv(request());
    expect(bare).not.toContain("--no-strict");
    expect(bare).not.toContain("--no-snapshot");
    expect(bare).not.toContain("--no-post");

    const loose = launchArgv(
      request({ noStrict: true, noSnapshot: true, noPost: true }),
    );
    expect(loose).toContain("--no-strict");
    expect(loose).toContain("--no-snapshot");
    expect(loose).toContain("--no-post");
  });

  it("carries --supersede, because dropping it silently declines the request", () => {
    expect(launchArgv(request())).not.toContain("--supersede");
    expect(launchArgv(request({ supersede: true }))).toContain("--supersede");
  });

  it("carries --linger, the caller's shape of run", () => {
    expect(launchArgv(request())).not.toContain("--linger");
    expect(launchArgv(request({ linger: true }))).toContain("--linger");
  });

  it("names the parent run and the request id only when there is one", () => {
    const bare = launchArgv(request());
    expect(bare).not.toContain("--parent-run");
    expect(bare).not.toContain("--request-id");

    const linked = launchArgv(
      request({ parentRunId: PARENT, requestId: "agent.retry.7" }),
    );
    expect(valueAfter(linked, "--parent-run")).toBe(PARENT);
    expect(valueAfter(linked, "--request-id")).toBe("agent.retry.7");
  });

  it("names the actor only when the launch knew one", () => {
    expect(launchArgv(request())).not.toContain("--actor");
    expect(valueAfter(launchArgv(request({ actor: "srid" })), "--actor")).toBe("srid");
    expect(valueAfter(launchArgv(request({ actor: "@local" })), "--actor")).toBe("@local");
  });

  it("emits one --host per pin", () => {
    const argv = launchArgv(request({ hostPins: ["builder-1", "builder-2"] }));
    expect(argv.filter((a) => a === "--host")).toHaveLength(2);
    expect(valueAfter(argv, "--host")).toBe("builder-1");
  });

  it("keeps a hostile selector as ONE token, with nothing joined or quoted", () => {
    const nasty = "unit; rm -rf / #@x86_64-linux";
    const argv = launchArgv(
      request({ scope: scope({ selectors: [nasty, "a b"], root: "with space" }) }),
    );
    expect(argv).toContain(nasty);
    expect(argv).toContain("a b");
    expect(valueAfter(argv, "--root")).toBe("with space");
    expect(argv.filter((a) => a === nasty)).toHaveLength(1);
    for (const token of argv) {
      expect(token.startsWith('"')).toBe(false);
      expect(token.startsWith("'")).toBe(false);
    }
  });

  it("is an array of strings — there is no place a command line could hide", () => {
    const argv = launchArgv(request({ scope: scope({ selectors: ["unit", "e2e"] }) }));
    expect(Array.isArray(argv)).toBe(true);
    for (const token of argv) expect(typeof token).toBe("string");
  });
});

describe("unitNameFor", () => {
  it("embeds the run id, so `systemctl --user status` names the right run", () => {
    expect(unitNameFor(RUN_ID)).toBe(`odu-run-${RUN_ID}`);
    expect(unitNameFor(RUN_ID)).toContain(RUN_ID);
    expect(unitNameFor(RUN_ID)).not.toBe(unitNameFor(PARENT));
  });

  it("is a plausible unit name", () => {
    expect(unitNameFor(RUN_ID)).toMatch(/^[A-Za-z0-9:_.@-]+$/);
  });
});

describe("when a launch may be tried again", () => {
  const submitter: SpawnPlan = {
    mechanism: "systemd-run",
    reason: "under a unit",
    exitIsDeath: false,
    describeExit: () => "",
  };
  const detached: SpawnPlan = {
    mechanism: "detached",
    reason: "no unit",
    exitIsDeath: true,
    describeExit: () => "",
  };

  it("retries when the user manager REFUSED the unit", () => {
    expect(mayRelaunchDetached(submitter, 1)).toBe(true);
  });

  it("does not retry when the manager ACCEPTED it — something may be coming up", () => {
    expect(mayRelaunchDetached(submitter, 0)).toBe(false);
  });

  it("does not retry when the submitter has not exited — the ceiling was hit", () => {
    expect(mayRelaunchDetached(submitter, null)).toBe(false);
  });

  it("never retries a detached spawn: that exit IS the coordinator's death", () => {
    expect(mayRelaunchDetached(detached, 1)).toBe(false);
    expect(mayRelaunchDetached(detached, 0)).toBe(false);
  });
});

describe("the environment a coordinator is started in", () => {
  const daemon = { PATH: "/bin", ODU_HOSTS: "/daemons/hosts.json" };

  it("gives the child the caller's hosts file, not this process's", () => {
    const env = coordinatorEnv(request({ hostsFile: "/callers/hosts.json" }), daemon);
    expect(env.ODU_HOSTS).toBe("/callers/hosts.json");
  });

  it("blanks it when the caller's own shell has none", () => {
    const env = coordinatorEnv(request({ hostsFile: "" }), daemon);
    expect(env.ODU_HOSTS).toBe("");
  });

  it("leaves the service's own standing when the caller expressed nothing", () => {
    const env = coordinatorEnv(request({ hostsFile: null }), daemon);
    expect(env.ODU_HOSTS).toBe("/daemons/hosts.json");
  });

  it("carries everything else through untouched", () => {
    const env = coordinatorEnv(request({ hostsFile: null }), daemon);
    expect(env.PATH).toBe("/bin");
  });

  it("does not mutate the environment it was handed", () => {
    coordinatorEnv(request({ hostsFile: "" }), daemon);
    expect(daemon.ODU_HOSTS).toBe("/daemons/hosts.json");
  });
});
