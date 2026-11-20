import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { dialRun } from "./dial";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function absentSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-dial-test-"));
  dirs.push(dir);
  return join(dir, "odu.sock");
}

async function withFailingConnect<T>(
  code: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const installed = Socket.prototype.connect;
  Socket.prototype.connect = function connect(this: Socket): Socket {
    queueMicrotask(() => {
      const err: NodeJS.ErrnoException = new Error(`stub ${code ?? "no code"}`);
      if (code !== undefined) err.code = code;
      this.emit("error", err);
    });
    return this;
  } as typeof Socket.prototype.connect;
  try {
    return await fn();
  } finally {
    Socket.prototype.connect = installed;
  }
}

describe("dialRun", () => {
  it("answers null for a path nothing is bound to", async () => {
    expect(await dialRun(absentSocketPath())).toBeNull();
  });

  it("answers null for the two codes that mean nobody is serving", async () => {
    for (const code of ["ENOENT", "ECONNREFUSED"]) {
      expect(
        await withFailingConnect(code, () => dialRun("/stub/odu.sock")),
        `${code} means there is no run to reach`,
      ).toBeNull();
    }
  });

  it("raises anything else, so a live socket never reads as no run", async () => {
    for (const code of ["EACCES", "ENOTSOCK", undefined]) {
      await expect(
        withFailingConnect(code, () => dialRun("/stub/odu.sock")),
      ).rejects.toThrow(`stub ${code ?? "no code"}`);
    }
  });
});
