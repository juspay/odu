/**
 * THE THINGS THIS PACKAGE'S TESTS SPELL THE SAME WAY.
 *
 * Each entry earned its place by drifting: `asRoot` was copied into three test
 * files the moment the engine started taking an `Authority`, and a fourth copy
 * is how one of them would come to name the wrong arm. `localStores` is the
 * stores a daemon with nothing declared holds, built by the row's own
 * `objectStores` so no suite spells where `local` lives.
 *
 * Not a door — `exports` in `package.json` opens `./surface`, `./server`,
 * `./cli` and `./face`, and this file is reachable only from inside the
 * package. It imports no test runner, so it cannot pull one into anything.
 */

import { join } from "node:path";
import { objectStores } from "./stores";

/** An administrative call authorised by the OPERATOR'S ROOT TOKEN — the arm a
 *  loopback daemon uses. */
export const asRoot = (rootToken: string) => ({
  authority: { kind: "root" as const, rootToken },
});

/** `local` alone, where the row puts it: under `<stateRoot>/cache`. */
export const localStores = (stateRoot: string) => objectStores(new Map(), join(stateRoot, "cache"));
