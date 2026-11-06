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
import { runTarget } from "./serviceFace";

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
    expect(at).toEqual({ checkout: POD, sha: SHA });
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
    expect(at).toEqual({ checkout: POD, sha: SHA });
  });

  it("accepts a loopback origin that was NAMED — the check is naming, not distance", () => {
    // A developer with two daemons on one machine means the one they named,
    // and the e2e drives exactly this shape. Refusing `127.0.0.1` would be a
    // rule about addresses that odu has no reason to hold.
    expect(
      runTarget({ checkout: POD, sha: SHA, origin: "http://127.0.0.1:18440" }, NOWHERE),
    ).toEqual({ checkout: POD, sha: SHA });
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
  it("carries the named pair verbatim into run.start", () => {
    const input = startInputOf(
      { checkout: POD, sha: SHA },
      opts({ checkout: POD, sha: SHA, origin: ORIGIN }),
    );
    expect(input.checkout).toBe(POD);
    expect(input.expectedSha).toBe(SHA);
  });

  it("sends this shell's $ODU_HOSTS for EVERY run, --checkout included", () => {
    // A face does not get to decide that a person's fleet stops applying to
    // their own run. `--checkout` does not even imply another machine — a
    // named `http://127.0.0.1:…` is this one — and a path the service has not
    // got is skipped by `loadHosts`, which falls through to its own chain.
    const remote = startInputOf(
      { checkout: POD, sha: SHA },
      opts({ checkout: POD, sha: SHA, origin: ORIGIN }),
    );
    const local = startInputOf({ checkout: "/code/app", sha: SHA }, opts());
    expect(remote.hostsFile).toBe(local.hostsFile);
    // Always a string, including `""` — the reading that says "my shell has
    // none", which is different from saying nothing at all.
    expect(typeof remote.hostsFile).toBe("string");
  });
});
