/**
 * Restores Node's `net.Socket` contract that a failed `connect()` reports its
 * error ASYNCHRONOUSLY, never during the `connect()` call itself.
 *
 * Under Bun 1.3.10 a unix-path connect whose `connect(2)` fails outright
 * (ENOENT for "nothing is bound there") can emit `'error'` synchronously from
 * inside `Socket.prototype.connect` — observed under `bun test`, not under a
 * plain `bun` run, so it is execution-context dependent rather than a clean
 * either/or. That breaks every caller written to Node's semantics, which is
 * all of them: the canonical shape is `const s = createConnection(path)`
 * followed by `s.once("error", …)`, and a synchronous emit lands before that
 * listener exists. An EventEmitter with no `'error'` listener throws, so the
 * error escapes the caller entirely instead of resolving its promise.
 *
 * Two @kolu/surface call sites depend on the async contract and are the reason
 * this exists — both reached from src/coordinator/socket.ts:
 *   - `probeSocket` (unix-socket.ts), which classifies ENOENT as "free to
 *     bind". Serving a socket on a fresh path is the NORMAL case, so the
 *     escaping error turns every successful serve into a thrown ENOENT.
 *   - `unixSocketLink` (links/unix-socket.ts), which rejects with the raw
 *     socket error so a dial against a dead run can be reported honestly.
 *
 * The patch is deliberately narrow: it only defers an emit that happened
 * *during* the `connect()` call, and only when the caller had no `'error'`
 * listener of its own at that moment. A caller that attached one first has
 * already handled the emit correctly, and re-emitting would deliver it twice.
 * When the runtime behaves (the emit is already async) nothing is captured and
 * this is a pass-through.
 *
 * Importing this module installs the patch — it is a runtime compat shim, so
 * the side effect IS the export. src/coordinator/socket.ts imports it, which
 * covers both odu processes and the test harness: every unix-socket dial and
 * serve in this repo goes through that module.
 */

import { Socket } from "node:net";

/** `connect` is overloaded (path / port / options forms). A transparent
 *  wrapper never inspects the tuple, so it is forwarded unexamined under one
 *  variadic signature rather than re-declaring every overload. */
// biome-ignore lint/suspicious/noExplicitAny: see above — the argument tuple is whatever the caller passed.
type Connect = (this: Socket, ...args: any[]) => Socket;

const nativeConnect = Socket.prototype.connect as Connect;

Socket.prototype.connect = function connect(
  this: Socket,
  ...args: Parameters<Connect>
): Socket {
  // Already-handled emits stay the caller's business.
  if (this.listenerCount("error") > 0) return nativeConnect.apply(this, args);

  let premature: Error | undefined;
  const capture = (err: Error): void => {
    premature = err;
  };
  this.on("error", capture);
  try {
    return nativeConnect.apply(this, args);
  } finally {
    this.off("error", capture);
    if (premature !== undefined) {
      const err = premature;
      // A microtask lands after the caller's `createConnection(...)` statement
      // returns, which is where it attaches its listener — the earliest point
      // that honors the contract.
      queueMicrotask(() => {
        this.emit("error", err);
      });
    }
  }
};
