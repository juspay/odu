/**
 * The local half: the daemon's address, and what a dial to it calls absence.
 *
 * `{ kind: "absent" }` is the answer a face turns into "no odu on this machine"
 * — kolu's Inspector draws no chip at all — so the set of failures that produce
 * it is a contract rather than an implementation detail: a socket somebody IS
 * serving that failed for some other reason arriving as `absent` would have
 * every face report "odu is not installed" about a daemon that is up.
 *
 * The absent case is exercised against a real path with nothing bound, and the
 * refusals through a stubbed `Socket.prototype.connect` — the same instrument
 * and the same reasons `@odu/run-client`'s dial test keeps (Bun reports ENOENT
 * for every unbound unix path, so a permission-denied dial cannot be staged for
 * real here).
 */

import { existsSync } from "node:fs";
import { Socket } from "node:net";
import { basename, dirname } from "node:path";
import { describe, expect, it } from "bun:test";
import { DEFAULT_SERVICE_ORIGIN, SERVICE_APP } from "./endpoint";
import { dialServiceSocket, serviceSocketPath, webAppNamespace } from "./socket";

/** An origin nobody runs a service on — so its home is a name no daemon has
 *  ever created, which is what makes the purity assertions deterministic. */
const UNUSED_ORIGIN = "http://127.0.0.1:59999";

/** Run `fn` with every `connect()` failing asynchronously — with `code` when
 *  given, and with none at all when not (the shape a post-connect wire failure
 *  has). Async, because that is the contract `asyncConnectError` restores and
 *  the one `unixSocketLink` is written against. */
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
    // An ordinary install must not move: this is the home every existing
    // daemon and gate already lives in.
    expect(webAppNamespace(DEFAULT_SERVICE_ORIGIN)).toBe(SERVICE_APP);
  });

  it("gives a moved origin its own name, and the same one every time", () => {
    const moved = webAppNamespace("http://127.0.0.1:9000");
    expect(moved.startsWith(`${SERVICE_APP}-`)).toBe(true);
    expect(webAppNamespace("http://127.0.0.1:9000")).toBe(moved);
  });

  it("treats two spellings of one port as two addresses", () => {
    // The reason the namespace is a digest of the ORIGIN rather than of the
    // port: `127.0.0.1:9000` and `[::1]:9000` are different listeners.
    expect(webAppNamespace("http://127.0.0.1:9000")).not.toBe(
      webAppNamespace("http://[::1]:9000"),
    );
  });
});

describe("serviceSocketPath", () => {
  it("names the socket inside the daemon's own home", () => {
    const path = serviceSocketPath(DEFAULT_SERVICE_ORIGIN);
    expect(path.endsWith(`${SERVICE_APP}.sock`)).toBe(true);
    // …and that home is named by the namespace rule, which is the whole reason
    // the daemon and a local client can derive the same path.
    expect(basename(dirname(path))).toBe(
      webAppNamespace(DEFAULT_SERVICE_ORIGIN),
    );
  });

  it("creates nothing — asking where a daemon is must not make its home", () => {
    // The purity claim: `daemonHome` (what the LAUNCHER uses) makes and verifies
    // the directory; a client that only wants to dial must not. A client that
    // created the home would be the second thing in the tree that decides a
    // daemon exists.
    const path = serviceSocketPath(UNUSED_ORIGIN);
    expect(existsSync(dirname(path))).toBe(false);
  });
});

describe("dialServiceSocket", () => {
  it("answers absent for a path nothing is bound to", async () => {
    // The ordinary state of a machine that has never run `odu web`.
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
    // EACCES on a socket somebody IS serving, and a rejection with no `code` —
    // the shape a connect that succeeded and then failed to speak the wire has.
    // Reporting either as absence is the bug this narrowing exists to prevent:
    // the face would say odu is not installed about a daemon that is up.
    for (const code of ["EACCES", "ENOTSOCK", undefined]) {
      await expect(
        withFailingConnect(code, () => dialServiceSocket(UNUSED_ORIGIN)),
        `${code ?? "no code"} is a live problem, not absence`,
      ).rejects.toThrow();
    }
  });
});
