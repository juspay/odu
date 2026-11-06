/**
 * WHICH CHECKOUT A RUN IS ABOUT, and what `odu ci run` then asks for (PLAN 4.4).
 *
 * `--checkout` is the flag that lets a person at a laptop start a run on a
 * server's own checkout — the pod's `/data/checkouts/<repo>` — and the whole of
 * its correctness is in two refusals and one non-transformation:
 *
 *   - it is REFUSED without `--sha`, because `expectedSha` is the only thing
 *     standing between "run that commit" and "run whatever is checked out
 *     there now";
 *   - it is REFUSED when no service is NAMED, because the default one is the
 *     daemon for the directory you are already standing in. The check is
 *     naming, not distance: an explicit `127.0.0.1` origin is accepted;
 *   - and when it is accepted, BOTH values travel verbatim. This side cannot
 *     see the path and must not resolve, normalise or re-read anything about
 *     it.
 *
 * The last one is pinned on `startInputOf` rather than through a live service:
 * what a face is entitled to send is a fact about this process, and the e2e
 * suite drives the same pair against a real daemon.
 */

import { describe, expect, it } from "bun:test";
import type { RunOpts } from "./serviceCommands";
import { startInputOf } from "./serviceCommands";
import { runTarget, type RunTarget } from "./serviceFace";

const POD = "/data/checkouts/kolu";
const SHA = "b".repeat(40);
const ORIGIN = "https://odu-k3s.example";

/** No `$ODU_WEB_ORIGIN`: the default loopback daemon, which is what a shell
 *  that has named nothing is pointed at. */
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
    // `mine: false` — the run's world is the service's, not this shell's.
    expect(at).toEqual({ checkout: POD, sha: SHA, mine: false });
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
    expect(at).toEqual({ checkout: POD, sha: SHA, mine: false });
  });

  it("accepts a loopback origin that was NAMED — the check is naming, not distance", () => {
    // A developer with two daemons on one machine means the one they named,
    // and the e2e drives exactly this shape. Refusing `127.0.0.1` would be a
    // rule about addresses that odu has no reason to hold.
    expect(
      runTarget({ checkout: POD, sha: SHA, origin: "http://127.0.0.1:18440" }, NOWHERE),
    ).toEqual({ checkout: POD, sha: SHA, mine: false });
  });

  it("does not take an EMPTY $ODU_WEB_ORIGIN as a naming", () => {
    // `export ODU_WEB_ORIGIN=` is a variable that is set and says nothing;
    // `serviceOrigin` reads it as the default, and so must this.
    expect(() =>
      runTarget({ checkout: POD, sha: SHA }, { ODU_WEB_ORIGIN: "  " }),
    ).toThrow(/so say which service/);
  });

  it("refuses a --sha with no --checkout rather than ignoring it", () => {
    // Here, odu reads HEAD itself. A `--sha` that was quietly dropped would
    // look like a strict gate the caller never actually got.
    expect(() => runTarget({ sha: SHA, origin: ORIGIN }, NOWHERE)).toThrow(
      /--sha names the commit of --checkout/,
    );
  });
});

describe("what the start asks for", () => {
  /** The two targets a start can have, built the ONE way a start builds them.
   *  Hand-writing a `RunTarget` here would be a second source for `mine` —
   *  the very thing `runTarget` answering it is meant to rule out. */
  const there = (): RunTarget =>
    runTarget({ checkout: POD, sha: SHA, origin: ORIGIN }, NOWHERE);
  const hereAt = (): RunTarget => ({ checkout: "/code/app", sha: SHA, mine: true });

  it("carries the named pair verbatim into run.start", () => {
    const input = startInputOf(there(), opts({ checkout: POD, sha: SHA, origin: ORIGIN }));
    expect(input.checkout).toBe(POD);
    expect(input.expectedSha).toBe(SHA);
  });

  /** This process's `$ODU_HOSTS`, set for the duration of one claim and put
   *  back — the runner's own value decides nothing. Without this the
   *  assertions below read `""` and pass for a reason that has nothing to do
   *  with forwarding. */
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
    // A face does not get to decide that a person's fleet stops applying to
    // their own run. `--checkout` does not even imply another machine — a
    // named `http://127.0.0.1:…` is this one — and a path the service has not
    // got is skipped by `loadHosts`, which falls through to its own chain.
    withHosts("/fleets/mine.json", () => {
      const remote = startInputOf(there(), opts({ checkout: POD, sha: SHA, origin: ORIGIN }));
      const local = startInputOf(hereAt(), opts());
      expect(remote.hostsFile).toBe("/fleets/mine.json");
      expect(local.hostsFile).toBe("/fleets/mine.json");
    });
  });

  it("sends NO hostsFile when the run's world is not this shell and it has none", () => {
    // `""` is not silence. It is kept as `""` all the way to `coordinatorEnv`,
    // which ASSIGNS it — so the coordinator would run with `ODU_HOSTS=""` and
    // the SERVICE's own variable blanked. On a pod whose Deployment sets the
    // fleet, that is the only inventory there is, bypassed. Absent is the
    // reading that leaves the daemon's configuration standing.
    withHosts(undefined, () => {
      expect("hostsFile" in startInputOf(there(), opts({ checkout: POD, sha: SHA, origin: ORIGIN })))
        .toBe(false);
    });
  });

  it("still sends `\"\"` for a run in THIS shell's world", () => {
    // The reading the comment in `startInputOf` has always protected: a person
    // who just unset `$ODU_HOSTS` means it, and saying nothing here would hand
    // their run the daemon's fleet instead. Keyed on the TARGET's `mine`, so
    // `--checkout $PWD` against this same daemon keeps it.
    withHosts(undefined, () => {
      expect(startInputOf(hereAt(), opts()).hostsFile).toBe("");
    });
  });
});
