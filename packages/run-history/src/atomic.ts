/**
 * Publication primitives — the two file operations every durable record in
 * this package is written with, and the reason a reader never sees half of one.
 *
 * `writeAtomic` is write-to-temp-then-rename. `rename(2)` within a directory is
 * atomic on every filesystem odu runs on, so a reader either sees the previous
 * bytes or the new ones and never a prefix. Writing in place would let a
 * SIGKILL between two `write(2)` calls leave a manifest that parses as
 * something — which is worse than one that does not parse at all, because the
 * forgiving reader this package asks for would then act on it.
 *
 * `createExclusive` is `O_CREAT|O_EXCL`: it succeeds for exactly one caller.
 * That is the whole of the concurrency control here — no lock daemon, no
 * advisory flock (which Node does not expose and which lies over NFS anyway),
 * just the one syscall whose atomicity every POSIX filesystem promises. The
 * ownership fence and the attempt allocator are both built on it.
 */

import { closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

/** Write `contents` so a concurrent reader sees all of it or none of it.
 *
 *  The temp name carries the pid and a random tail: two writers publishing the
 *  same path concurrently must not collide on the temp file, or one would
 *  rename the other's half-written bytes into place — the exact tear this
 *  function exists to prevent, reintroduced by the fix for it. */
export function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(
    dirname(path),
    `.${process.pid.toString(36)}-${Math.floor(Math.random() * 36 ** 6).toString(36)}.tmp`,
  );
  try {
    // fsync before rename: the rename is atomic with respect to other readers,
    // but on a crash the metadata operation can land before the data. A record
    // that renames into place empty is exactly the torn read the atomicity is
    // supposed to rule out.
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, contents);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temp file may never have been created; its absence is fine.
    }
    throw err;
  }
}

/** Create `path` with `contents`, or report that somebody else already has.
 *  `false` is the ONLY failure this reports — every other error propagates,
 *  because "the directory is not writable" and "another writer won the race"
 *  are different facts and a caller that conflates them will retry forever. */
export function createExclusive(path: string, contents: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, contents, { flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}
