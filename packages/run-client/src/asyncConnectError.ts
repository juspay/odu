/**
 * Restores Node's `net.Socket` contract that a failed `connect()` reports its
 * error ASYNCHRONOUSLY, never during the `connect()` call itself.
 *
 * Under Bun 1.3.10 a unix-path connect whose `connect(2)` fails outright
 * (ENOENT for "nothing is bound there") can emit `'error'` synchronously from
 * inside `Socket.prototype.connect` — observed under `bun test`, not under a
 * plain `bun` run. A synchronous emit lands before the caller's `'error'`
 * listener exists, and an EventEmitter with no `'error'` listener throws.
 */

import { Socket } from "node:net";

type Connect = (this: Socket, ...args: any[]) => Socket;

const nativeConnect = Socket.prototype.connect as Connect;

Socket.prototype.connect = function connect(
  this: Socket,
  ...args: Parameters<Connect>
): Socket {
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
      queueMicrotask(() => {
        this.emit("error", err);
      });
    }
  }
};
