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
    const linux = pinName("juspay/kolu", "master", "x86_64-linux");
    const darwin = pinName("juspay/kolu", "master", "aarch64-darwin");
    expect(linux).not.toBe(darwin);
  });

  it("gives each repository of one bucket its own pin", () => {
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
    for (const args of [
      ["", "master", "x86_64-linux"],
      ["juspay/odu", "", "x86_64-linux"],
      ["juspay/odu", "master", ""],
    ]) {
      expect(() => execFileSync("bash", [SCRIPT, ...args], { stdio: "pipe" })).toThrow();
    }
  });
});
