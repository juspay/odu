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

const fullEnv = {
  ODU_STATE_DIR: "/explicit/state",
  XDG_STATE_HOME: "/xdg/state",
  HOME: "/home/tester",
} as const;

describe("ODU_STATE_DIR outranks every other rung", () => {
  it("wins on both platforms, and is used verbatim rather than suffixed", () => {
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
    expect(
      stateRoot({ XDG_STATE_HOME: "/xdg/state", HOME: "/Users/tester" }, "darwin"),
    ).toBe("/Users/tester/Library/Application Support/odu");
  });
});

describe("an empty or blank variable means unset, not an empty path", () => {
  it("skips an empty ODU_STATE_DIR rather than resolving the catalog to /", () => {
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
    const home = homedir();
    if (home === "") {
      expect(() => stateRoot({ HOME: "" }, "linux")).toThrow(/ODU_STATE_DIR/);
      return;
    }
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
    expect(attemptDir("/state/runs/12345678-abcd", "ci~3A~3Ae2e~40linux", 2)).toBe(
      "/state/runs/12345678-abcd/attempts/ci~3A~3Ae2e~40linux/2",
    );
    expect(attemptDir("/run", "k", 1)).toBe(
      join("/run", RUN_FILES.attempts, "k", "1"),
    );
  });

  it("keeps the journal extension-less so no reader is invited to parse it whole", () => {
    expect(RUN_FILES.events).toBe("events");
    expect(RUN_FILES.events.includes(".")).toBe(false);
    expect(ATTEMPT_FILES.log.includes(".")).toBe(false);
  });
});
