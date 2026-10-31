/**
 * THE THINGS THIS PACKAGE'S TESTS SPELL THE SAME WAY.
 *
 * One entry, and it earned its place by drifting: `asRoot` was copied into
 * three test files the moment the engine started taking an `Authority`, and a
 * fourth copy is how one of them would come to name the wrong arm.
 *
 * Not a door — `exports` in `package.json` opens `./surface`, `./server`,
 * `./cli` and `./face`, and this file is reachable only from inside the
 * package. It imports nothing, so it cannot pull a test runner into anything.
 */

/** An administrative call authorised by the OPERATOR'S ROOT TOKEN — the arm a
 *  loopback daemon uses. */
export const asRoot = (rootToken: string) => ({
  authority: { kind: "root" as const, rootToken },
});
