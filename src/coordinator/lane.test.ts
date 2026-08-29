/**
 * The attachLogs feed-death path: a sealed-log append must not escape the
 * tap, and the lane must die before we even try to narrate.
 */

import { describe, expect, it } from "bun:test";
import { reportLogStreamDeath } from "./lane";

describe("reportLogStreamDeath", () => {
  it("dies first, then appends, and swallows an append-after-end throw", () => {
    const order: string[] = [];
    expect(() =>
      reportLogStreamDeath({
        silenced: false,
        die: (error) => {
          order.push(`die:${error}`);
        },
        onLogFrame: (nodeId, frame) => {
          order.push(`append:${nodeId}:${frame.kind}`);
          throw new Error(
            `logTail: append to ${nodeId} after its log ended — a terminal frame promises no further bytes; call reset() to re-open the log instead`,
          );
        },
        nodeId: "fast",
        error: new Error("EPIPE"),
      }),
    ).not.toThrow();
    expect(order).toEqual(["die:log stream died (fast): EPIPE", "append:fast:append"]);
  });

  it("is a no-op when the lane is already quiet", () => {
    let died = false;
    let appended = false;
    reportLogStreamDeath({
      silenced: true,
      die: () => {
        died = true;
      },
      onLogFrame: () => {
        appended = true;
      },
      nodeId: "fast",
      error: new Error("EPIPE"),
    });
    expect(died).toBe(false);
    expect(appended).toBe(false);
  });

  it("swallows a throw from die itself", () => {
    expect(() =>
      reportLogStreamDeath({
        silenced: false,
        die: () => {
          throw new Error("onDead boom");
        },
        onLogFrame: () => {
          throw new Error("must not run");
        },
        nodeId: "slow",
        error: new Error("EPIPE"),
      }),
    ).not.toThrow();
  });
});
