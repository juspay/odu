/**
 * What `dialRun` calls absence, and what it refuses to.
 *
 * `null` is the answer a face turns into "no run in progress" — a quiet chip,
 * the last durable verdict, justci's one-line refusal. So the set of failures
 * that produce it is a contract, not an implementation detail: a live socket
 * that failed for some other reason arriving as `null` would have every face
 * report "no run" about a run that is up.
 *
 * The absent case is exercised against a real path with nothing bound, which
 * is the one that matters in practice and the one a refactor is most likely to
 * change by accident. The refusals are driven through a stubbed
 * `Socket.prototype.connect`, because Bun reports ENOENT for every unbound
 * unix path — a permission-denied or not-a-socket dial cannot be staged for
 * real here, and asserting the rule directly beats asserting nothing.
 */

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
    // EACCES on a socket somebody IS serving, and a rejection with no `code` —
    // the shape a connect that succeeded and then failed to speak the wire
    // has. Reporting either as absence is the bug this narrowing exists to
    // prevent: the face would fall back to the last verdict and say nothing.
    for (const code of ["EACCES", "ENOTSOCK", undefined]) {
      await expect(
        withFailingConnect(code, () => dialRun("/stub/odu.sock")),
      ).rejects.toThrow(`stub ${code ?? "no code"}`);
    }
  });
});
