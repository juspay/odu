import { describe, expect, it } from "bun:test";
import type { RunOpts } from "./serviceCommands";
import { startInputOf } from "./serviceCommands";
import { runTarget, type RunTarget } from "./serviceFace";

const POD = "/data/checkouts/kolu";
const SHA = "b".repeat(40);
const ORIGIN = "https://odu-k3s.example";

const NOWHERE: Record<string, string | undefined> = {};

function opts(over: Partial<RunOpts> = {}): RunOpts {
  return {
    selectors: [],
    platforms: [],
    hostPins: [],
    noDeps: false,
    noStrict: false,
    noSnapshot: false,
    noPost: false,
    supersede: false,
    linger: false,
    noWait: false,
    json: false,
    ...over,
  };
}

describe("odu ci run --checkout", () => {
  it("sends the path and the commit exactly as typed", () => {
    const at = runTarget({ checkout: POD, sha: SHA, origin: ORIGIN }, NOWHERE);
    expect(at).toEqual({ checkout: POD, sha: SHA, world: "elsewhere" });
  });

  it("refuses without --sha, because the strict gate has nothing to compare", () => {
    expect(() => runTarget({ checkout: POD, origin: ORIGIN }, NOWHERE)).toThrow(
      /--checkout needs --sha/,
    );
  });

  it("refuses when NO service is named, because the default one is where you stand", () => {
    expect(() => runTarget({ checkout: POD, sha: SHA }, NOWHERE)).toThrow(
      /so say which service/,
    );
  });

  it("takes $ODU_WEB_ORIGIN as the naming, so a shell can export it once", () => {
    const at = runTarget(
      { checkout: POD, sha: SHA },
      { ODU_WEB_ORIGIN: ORIGIN },
    );
    expect(at).toEqual({ checkout: POD, sha: SHA, world: "elsewhere" });
  });

  it("accepts a loopback origin that was NAMED — the check is naming, not distance", () => {
    expect(
      runTarget({ checkout: POD, sha: SHA, origin: "http://127.0.0.1:18440" }, NOWHERE),
    ).toEqual({ checkout: POD, sha: SHA, world: "elsewhere" });
  });

  it("does not take an EMPTY $ODU_WEB_ORIGIN as a naming", () => {
    expect(() =>
      runTarget({ checkout: POD, sha: SHA }, { ODU_WEB_ORIGIN: "  " }),
    ).toThrow(/so say which service/);
  });

  it("refuses a --sha with no --checkout rather than ignoring it", () => {
    expect(() => runTarget({ sha: SHA, origin: ORIGIN }, NOWHERE)).toThrow(
      /--sha names the commit of --checkout/,
    );
  });

  it("carries --branch beside the pair, as the licence to move that clone", () => {
    const at = runTarget(
      { checkout: POD, sha: SHA, branch: "master", origin: ORIGIN },
      NOWHERE,
    );
    expect(at).toEqual({ checkout: POD, sha: SHA, branch: "master", world: "elsewhere" });
    expect(
      startInputOf(at, opts({ checkout: POD, sha: SHA, branch: "master", origin: ORIGIN })).branch,
    ).toBe("master");
  });

  it("sends NO branch when none was given, which is today's stricter rule", () => {
    const at = runTarget({ checkout: POD, sha: SHA, origin: ORIGIN }, NOWHERE);
    expect("branch" in startInputOf(at, opts({ checkout: POD, sha: SHA, origin: ORIGIN }))).toBe(
      false,
    );
  });

  it("refuses a --branch with no --checkout rather than ignoring it", () => {
    expect(() => runTarget({ branch: "master", origin: ORIGIN }, NOWHERE)).toThrow(
      /--branch names the branch of --checkout/,
    );
  });
});

describe("what the start asks for", () => {
  const there = (): RunTarget =>
    runTarget({ checkout: POD, sha: SHA, origin: ORIGIN }, NOWHERE);
  const hereAt = (): RunTarget => ({ checkout: "/code/app", sha: SHA, world: "here" });

  it("carries the named pair verbatim into run.start", () => {
    const input = startInputOf(there(), opts({ checkout: POD, sha: SHA, origin: ORIGIN }));
    expect(input.checkout).toBe(POD);
    expect(input.expectedSha).toBe(SHA);
  });

  function withHosts<T>(value: string | undefined, body: () => T): T {
    const before = process.env.ODU_HOSTS;
    if (value === undefined) delete process.env.ODU_HOSTS;
    else process.env.ODU_HOSTS = value;
    try {
      return body();
    } finally {
      if (before === undefined) delete process.env.ODU_HOSTS;
      else process.env.ODU_HOSTS = before;
    }
  }

  it("sends this shell's $ODU_HOSTS path for EVERY run, --checkout included", () => {
    withHosts("/fleets/mine.json", () => {
      const remote = startInputOf(there(), opts({ checkout: POD, sha: SHA, origin: ORIGIN }));
      const local = startInputOf(hereAt(), opts());
      expect(remote.hostsFile).toBe("/fleets/mine.json");
      expect(local.hostsFile).toBe("/fleets/mine.json");
    });
  });

  it("sends NO hostsFile when the run's world is not this shell and it has none", () => {
    withHosts(undefined, () => {
      expect("hostsFile" in startInputOf(there(), opts({ checkout: POD, sha: SHA, origin: ORIGIN })))
        .toBe(false);
    });
  });

  it("still sends `\"\"` for a run in THIS shell's world", () => {
    withHosts(undefined, () => {
      expect(startInputOf(hereAt(), opts()).hostsFile).toBe("");
    });
  });
});
