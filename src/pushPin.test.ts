/**
 * THE NAME A CI PUSH PINS UNDER, held to the collisions it exists to avoid.
 *
 * `.github/actions/push` no longer takes a pin NAME — it takes `pin: true`
 * and derives one. The derivation is three facts long and every one of them
 * is load-bearing, so it is a script of its own (`pin-name.sh`) and this is
 * the test that says why: four repositories share the `kolu` bucket, every
 * one of their workflows runs a Linux job and a macOS job, and all of it
 * lands on the same bucket on the same push. A name two of those jobs share
 * is a pin the second one re-points — which RELEASES the first one's closure
 * at the next collection, silently, because a pin that moved looks exactly
 * like a pin that was taken.
 *
 * Driven as a shell script with real arguments rather than re-implemented
 * here: the thing CI runs is the thing under test.
 */

import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", ".github", "actions", "push", "pin-name.sh");

const pinName = (repository: string, ref: string, system: string): string =>
  execFileSync("bash", [SCRIPT, repository, ref, system], { encoding: "utf-8" }).trim();

describe("the pin name a push derives", () => {
  it("is the repository, the ref and the system", () => {
    expect(pinName("juspay/kolu", "master", "x86_64-linux")).toBe(
      "juspay/kolu@master/x86_64-linux",
    );
  });

  it("gives each system of one push its own pin", () => {
    // THE MATRIX. Both jobs push the same commit of the same ref into the
    // same bucket; under one name the second to finish would hand the first
    // one's closure to the next collection.
    const linux = pinName("juspay/kolu", "master", "x86_64-linux");
    const darwin = pinName("juspay/kolu", "master", "aarch64-darwin");
    expect(linux).not.toBe(darwin);
  });

  it("gives each repository of one bucket its own pin", () => {
    // kolu, olai, agent-distro and odu all push to `kolu`.
    const names = ["juspay/kolu", "juspay/olai", "juspay/agent-distro", "juspay/odu"].map(
      (repository) => pinName(repository, "master", "x86_64-linux"),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it("says which ref it holds, so two refs are two pins", () => {
    expect(pinName("juspay/odu", "release-2", "x86_64-linux")).toBe(
      "juspay/odu@release-2/x86_64-linux",
    );
    expect(pinName("juspay/odu", "release-2", "x86_64-linux")).not.toBe(
      pinName("juspay/odu", "master", "x86_64-linux"),
    );
  });

  it("refuses to name a pin it cannot name fully", () => {
    // A blank part would make `odu/@/x86_64-linux` — a name that still looks
    // like a pin and collides with the next caller missing the same fact.
    for (const args of [
      ["", "master", "x86_64-linux"],
      ["juspay/odu", "", "x86_64-linux"],
      ["juspay/odu", "master", ""],
    ]) {
      expect(() => execFileSync("bash", [SCRIPT, ...args], { stdio: "pipe" })).toThrow();
    }
  });
});
