import { closeSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

export function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(
    dirname(path),
    `.${process.pid.toString(36)}-${Math.floor(Math.random() * 36 ** 6).toString(36)}.tmp`,
  );
  try {
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
    }
    throw err;
  }
}

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
