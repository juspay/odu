import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import "./asyncConnectError";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function absentSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-connect-test-"));
  dirs.push(dir);
  return join(dir, "absent.sock");
}

describe("async connect errors", () => {
  it("reaches a listener attached after createConnection returns", async () => {
    const code = await new Promise<string | undefined>((resolve, reject) => {
      const socket = createConnection(absentSocketPath());
      socket.once("connect", () => {
        socket.destroy();
        reject(new Error("connected to an absent socket"));
      });
      socket.once("error", (err) => {
        socket.destroy();
        resolve((err as NodeJS.ErrnoException).code);
      });
    });
    expect(code).toBe("ENOENT");
  });

  it("delivers exactly once when the caller listens before connecting", async () => {
    const codes: string[] = [];
    const socket = new Socket();
    const first = new Promise<void>((resolve) => {
      socket.on("error", (err) => {
        codes.push((err as NodeJS.ErrnoException).code ?? "");
        resolve();
      });
    });
    socket.connect(absentSocketPath());
    await first;
    await new Promise((resolve) => setTimeout(resolve, 20));
    socket.destroy();
    expect(codes).toEqual(["ENOENT"]);
  });
});
