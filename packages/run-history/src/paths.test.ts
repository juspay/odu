/**
 * Where the catalog lives — the resolution ORDER, and the fact that a missing
 * rung never falls through to the current directory.
 *
 * This module is one `if`-ladder, which is exactly the kind of code that keeps
 * working while meaning the wrong thing: an override consulted after the
 * platform branch would strand every darwin test in the developer's real
 * `~/Library`, an empty-string variable treated as set would resolve the
 * catalog to `/odu`, and a `cwd` fallback for a missing home would silently
 * reinstate the checkout-scoped layout this package exists to replace. None of
 * those announce themselves — they just write somewhere.
 *
 * So every test names its own world: `env` and `platform` are passed in and
 * the process's real environment is never consulted. The single exception is
 * the no-home case, where the module deliberately falls back to `os.homedir()`
 * — that one is written to assert the fallback, not the developer's HOME.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  ATTEMPT_FILES,
  RUN_FILES,
  attemptDir,
  catalogRoot,
  runDir,
  stateRoot,
} from "./paths";

/** A world with every rung populated and mutually distinguishable, so a test
 *  that asserts one rung proves the others were not taken. */
const fullEnv = {
  ODU_STATE_DIR: "/explicit/state",
  XDG_STATE_HOME: "/xdg/state",
  HOME: "/home/tester",
} as const;

describe("ODU_STATE_DIR outranks every other rung", () => {
  it("wins on both platforms, and is used verbatim rather than suffixed", () => {
    // Verbatim matters: this is the rung a test suite and a service manager
    // both use, and they hand over the directory they mean, not its parent.
    expect(stateRoot(fullEnv, "linux")).toBe("/explicit/state");
    expect(stateRoot(fullEnv, "darwin")).toBe("/explicit/state");
  });

  it("still wins when nothing else is set at all", () => {
    expect(stateRoot({ ODU_STATE_DIR: "/only" }, "linux")).toBe("/only");
    expect(stateRoot({ ODU_STATE_DIR: "/only" }, "darwin")).toBe("/only");
  });
});

describe("Linux resolves to XDG state, then the spec's default", () => {
  it("uses XDG_STATE_HOME/odu when the variable is set", () => {
    expect(stateRoot({ XDG_STATE_HOME: "/xdg/state", HOME: "/h" }, "linux")).toBe(
      "/xdg/state/odu",
    );
  });

  it("falls back to ~/.local/state/odu — state, not cache and not config", () => {
    expect(stateRoot({ HOME: "/home/tester" }, "linux")).toBe(
      "/home/tester/.local/state/odu",
    );
  });
});

describe("macOS resolves to Application Support and ignores XDG entirely", () => {
  it("uses ~/Library/Application Support/odu", () => {
    expect(stateRoot({ HOME: "/Users/tester" }, "darwin")).toBe(
      "/Users/tester/Library/Application Support/odu",
    );
  });

  it("does not consult XDG_STATE_HOME there, even when it is set", () => {
    // A developer who exports XDG_STATE_HOME on a Mac (plenty do) must not
    // get a different catalog from one who does not.
    expect(
      stateRoot({ XDG_STATE_HOME: "/xdg/state", HOME: "/Users/tester" }, "darwin"),
    ).toBe("/Users/tester/Library/Application Support/odu");
  });
});

describe("an empty or blank variable means unset, not an empty path", () => {
  it("skips an empty ODU_STATE_DIR rather than resolving the catalog to /", () => {
    // `ODU_STATE_DIR=` in a shell profile, or a service manager exporting a
    // variable it never filled in: the next rung must take over.
    expect(stateRoot({ ODU_STATE_DIR: "", HOME: "/home/tester" }, "linux")).toBe(
      "/home/tester/.local/state/odu",
    );
    expect(
      stateRoot({ ODU_STATE_DIR: "   ", HOME: "/Users/tester" }, "darwin"),
    ).toBe("/Users/tester/Library/Application Support/odu");
  });

  it("skips an empty XDG_STATE_HOME rather than resolving the catalog to /odu", () => {
    expect(stateRoot({ XDG_STATE_HOME: "", HOME: "/home/tester" }, "linux")).toBe(
      "/home/tester/.local/state/odu",
    );
    expect(
      stateRoot({ XDG_STATE_HOME: "  ", HOME: "/home/tester" }, "linux"),
    ).toBe("/home/tester/.local/state/odu");
  });

  it("skips an empty HOME rather than resolving the catalog under /", () => {
    // The claim under test is the NEGATIVE one: whatever it answers, it is
    // never a bare `/.local/state/odu` and never a relative path off the cwd
    // — that would put a per-user catalog wherever the process started.
    const home = homedir();
    if (home === "") {
      // No home the OS can name either: the only case that may fail.
      expect(() => stateRoot({ HOME: "" }, "linux")).toThrow(/ODU_STATE_DIR/);
      return;
    }
    // …otherwise the documented fallback is os.homedir(), on both platforms.
    expect(stateRoot({ HOME: "" }, "linux")).toBe(
      join(home, ".local", "state", "odu"),
    );
    expect(stateRoot({ HOME: "   " }, "darwin")).toBe(
      join(home, "Library", "Application Support", "odu"),
    );
  });
});

describe("the layout under the state root", () => {
  it("puts the catalog one level down, so state can hold more than runs later", () => {
    expect(catalogRoot({ ODU_STATE_DIR: "/state" }, "linux")).toBe("/state/runs");
    expect(catalogRoot({ HOME: "/home/tester" }, "linux")).toBe(
      "/home/tester/.local/state/odu/runs",
    );
  });

  it("gives each run a directory named by its id", () => {
    expect(runDir("/state/runs", "12345678-abcd")).toBe(
      "/state/runs/12345678-abcd",
    );
  });

  it("composes an attempt directory as <run>/attempts/<encoded node>/<n>", () => {
    // The node segment arrives ENCODED (see ./ids) — this function joins, it
    // does not police, so the test uses the encoded spelling a caller owes it.
    expect(attemptDir("/state/runs/12345678-abcd", "ci~3A~3Ae2e~40linux", 2)).toBe(
      "/state/runs/12345678-abcd/attempts/ci~3A~3Ae2e~40linux/2",
    );
    // The `attempts` segment is the constant, not a second copy of the word.
    expect(attemptDir("/run", "k", 1)).toBe(
      join("/run", RUN_FILES.attempts, "k", "1"),
    );
  });

  it("keeps the journal extension-less so no reader is invited to parse it whole", () => {
    // A crash can leave the last line torn; `.json` would advertise a file
    // that `JSON.parse` should be pointed at, which is the one thing that
    // must never happen to it.
    expect(RUN_FILES.events).toBe("events");
    expect(RUN_FILES.events.includes(".")).toBe(false);
    expect(ATTEMPT_FILES.log.includes(".")).toBe(false);
  });
});
