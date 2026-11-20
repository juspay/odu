import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "bun:test";
import { DEFAULT_SERVICE_ORIGIN, SERVICE_APP } from "./endpoint";
import { dialServiceSocket, serviceSocketPath, webAppNamespace } from "./socket";

const UNUSED_ORIGIN = "http://127.0.0.1:59999";

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

describe("webAppNamespace", () => {
  it("keeps the plain namespace for the default origin", () => {
    expect(webAppNamespace(DEFAULT_SERVICE_ORIGIN)).toBe(SERVICE_APP);
  });

  it("gives a moved origin its own name, and the same one every time", () => {
    const moved = webAppNamespace("http://127.0.0.1:9000");
    expect(moved.startsWith(`${SERVICE_APP}-`)).toBe(true);
    expect(webAppNamespace("http://127.0.0.1:9000")).toBe(moved);
  });

  it("treats two spellings of one port as two addresses", () => {
    expect(webAppNamespace("http://127.0.0.1:9000")).not.toBe(
      webAppNamespace("http://[::1]:9000"),
    );
  });
});

describe("serviceSocketPath", () => {
  it("names the socket inside the daemon's own home", () => {
    const path = serviceSocketPath(DEFAULT_SERVICE_ORIGIN, {});
    expect(path.endsWith(`${SERVICE_APP}.sock`)).toBe(true);
    expect(basename(dirname(path))).toBe(
      webAppNamespace(DEFAULT_SERVICE_ORIGIN),
    );
  });

  it("follows $ODU_STATE_DIR, which already holds the catalog and the cache", () => {
    const env = { ODU_STATE_DIR: "/data/odu" };
    const path = serviceSocketPath(DEFAULT_SERVICE_ORIGIN, env);
    expect(path).toBe(join("/data/odu", SERVICE_APP, `${SERVICE_APP}.sock`));
    const other = serviceSocketPath(UNUSED_ORIGIN, env);
    const namespace = webAppNamespace(UNUSED_ORIGIN);
    expect(other).toBe(join("/data/odu", namespace, `${namespace}.sock`));
    expect(other).not.toBe(path);
  });

  it("ignores $XDG_STATE_HOME, which is kolu's rule and not ours to break", () => {
    const withXdg = serviceSocketPath(DEFAULT_SERVICE_ORIGIN, {
      XDG_STATE_HOME: "/tmp/xdg-state",
      HOME: "/home/someone",
    });
    expect(withXdg).toBe(serviceSocketPath(DEFAULT_SERVICE_ORIGIN, { HOME: "/home/someone" }));
    expect(withXdg.startsWith("/tmp/xdg-state")).toBe(false);
  });

  it("treats an empty $ODU_STATE_DIR as unset", () => {
    expect(serviceSocketPath(DEFAULT_SERVICE_ORIGIN, { ODU_STATE_DIR: "  " })).toBe(
      serviceSocketPath(DEFAULT_SERVICE_ORIGIN, {}),
    );
  });

  it("creates nothing — asking where a daemon is must not make its home", () => {
    const path = serviceSocketPath(UNUSED_ORIGIN, {});
    expect(existsSync(dirname(path))).toBe(false);
  });
});

describe("dialServiceSocket", () => {
  it("answers absent for a path nothing is bound to", async () => {
    expect(await dialServiceSocket(UNUSED_ORIGIN)).toEqual({
      kind: "absent",
      socketPath: serviceSocketPath(UNUSED_ORIGIN),
    });
  });

  it("answers absent for the two codes that mean nobody is serving", async () => {
    for (const code of ["ENOENT", "ECONNREFUSED"]) {
      const dial = await withFailingConnect(code, () =>
        dialServiceSocket(UNUSED_ORIGIN),
      );
      expect(dial.kind, `${code} means there is no service to reach`).toBe(
        "absent",
      );
    }
  });

  it("raises anything else, so a live socket never reads as no service", async () => {
    for (const code of ["EACCES", "ENOTSOCK", undefined]) {
      await expect(
        withFailingConnect(code, () => dialServiceSocket(UNUSED_ORIGIN)),
        `${code ?? "no code"} is a live problem, not absence`,
      ).rejects.toThrow();
    }
  });

  it("refuses a daemon that accepts the socket and never publishes its cell", async () => {
    const home = mkdtempSync(join(tmpdir(), "odu-socket-test-"));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    const socketPath = serviceSocketPath(UNUSED_ORIGIN);
    mkdirSync(dirname(socketPath), { recursive: true });
    const server = createServer(() => {
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    try {
      await expect(
        dialServiceSocket(UNUSED_ORIGIN, { handshakeMs: 100 }),
      ).rejects.toThrow(/did not answer the handshake/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
