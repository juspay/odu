/**
 * The argv a launch request becomes — "structured data, never a string to
 * eval", made falsifiable.
 *
 * A retry re-launches a run from a RECORDED scope, and the scope contains
 * caller-supplied selectors. The moment that argv is built by concatenating
 * into a shell string, a selector is a command; the moment a flag is dropped, a
 * replay silently becomes a different run than the one it claims to replay. So
 * two properties, and both of them are easy to lose without a test noticing:
 *
 *   - EVERY ARGUMENT IS ITS OWN TOKEN. A selector containing a space, a quote
 *     or a semicolon stays exactly one element of the array. Nothing here joins.
 *   - IDENTITY AND COMMIT ARE NEVER OPTIONAL. `--run-id` and `--expected-sha`
 *     ride on every launch, because the caller minted the id before the spawn
 *     (that is what makes a lost reply recoverable) and because a launcher must
 *     never substitute today's HEAD for the commit being replayed.
 *
 * The optional half is pinned from BOTH sides — present when the request says
 * so, absent when it does not — since a flag that is always emitted is as wrong
 * as one that never is: `--no-deps` on a replay would run a node without what
 * it needs.
 *
 * `packagedLauncher` is deliberately not tested here: it spawns real
 * coordinator processes and waits on real sockets. What it is MADE of — the
 * argv, the unit name, and the spawn plan (`./spawn.test.ts`) — is all pure and
 * all here.
 */

import { describe, expect, it } from "bun:test";
import type { RunScope } from "@odu/run-history/schema";
import { type LaunchRequest, launchArgv, unitNameFor } from "./launcher";

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
    ...over,
  };
}

/** The value that follows `flag`, or undefined when the flag is absent. */
function valueAfter(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

describe("launchArgv", () => {
  it("always carries the minted run id and the commit being replayed", () => {
    // The two fields with no "when" clause. Without the id, a launcher that
    // lost its answer cannot ask whether the run happened; without the sha, the
    // child's strict gate has nothing to refuse against.
    const argv = launchArgv(request());
    expect(argv[0]).toBe("run");
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
    expect(argv.slice(0, 3)).toEqual(["run", "unit", "e2e"]);
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
    // A replay that invented `--no-deps` would run a node without the
    // dependencies it needs, and call the result the same run.
    expect(launchArgv(request())).not.toContain("--no-deps");
    expect(launchArgv(request({ scope: scope({ noDeps: true }) }))).toContain(
      "--no-deps",
    );
  });

  it("carries the strict-mode flags so a replay reproduces its parent", () => {
    // Not today's defaults: a run recorded as `live` must replay as `live`, or
    // the replay is a different run wearing the same lineage.
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

  it("emits one --host per pin", () => {
    const argv = launchArgv(request({ hostPins: ["builder-1", "builder-2"] }));
    expect(argv.filter((a) => a === "--host")).toHaveLength(2);
    expect(valueAfter(argv, "--host")).toBe("builder-1");
  });

  it("keeps a hostile selector as ONE token, with nothing joined or quoted", () => {
    // The property the whole port exists for. A selector is a caller's string;
    // if anything here joined tokens, this is where a shell would get one.
    const nasty = "unit; rm -rf / #@x86_64-linux";
    const argv = launchArgv(
      request({ scope: scope({ selectors: [nasty, "a b"], root: "with space" }) }),
    );
    expect(argv).toContain(nasty);
    expect(argv).toContain("a b");
    expect(valueAfter(argv, "--root")).toBe("with space");
    // Nothing in the array is a shell line: no element holds two of the tokens
    // we put in, and no element was wrapped in quotes on its way through.
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
    // Two runs never collide on a unit name.
    expect(unitNameFor(RUN_ID)).not.toBe(unitNameFor(PARENT));
  });

  it("is a plausible unit name", () => {
    // systemd unit names are a restricted alphabet; a name that needed escaping
    // would fail at `systemd-run` time on someone else's machine.
    expect(unitNameFor(RUN_ID)).toMatch(/^[A-Za-z0-9:_.@-]+$/);
  });
});
