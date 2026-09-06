/**
 * Lane feed-death: die is exception-safe, the absorb is sealed-log-only, and
 * an isolated stream fault does not error the whole lane.
 */

import { describe, expect, it } from "bun:test";
import { reportLogStreamDeath, runLaneDeath } from "./lane";

const sealed = (id: string): Error =>
  new Error(
    `logTail: append to ${id} after its log ended — a terminal frame promises no further bytes; call reset() to re-open the log instead`,
  );

describe("runLaneDeath", () => {
  it("runs teardown and onDead even when announce throws, then propagates", () => {
    const order: string[] = [];
    expect(() =>
      runLaneDeath(
        () => {
          order.push("announce");
          throw new Error("setup line sealed");
        },
        () => {
          order.push("teardown");
        },
        (error) => {
          order.push(`onDead:${error}`);
        },
        "pipe died",
      ),
    ).toThrow("setup line sealed");
    expect(order).toEqual(["announce", "teardown", "onDead:pipe died"]);
  });

  it("runs teardown before onDead, and an onDead throw still leaves teardown done", () => {
    const order: string[] = [];
    expect(() =>
      runLaneDeath(
        () => {
          order.push("announce");
        },
        () => {
          order.push("teardown");
        },
        () => {
          order.push("onDead");
          throw new Error("onDead boom");
        },
        "pipe died",
      ),
    ).toThrow("onDead boom");
    expect(order).toEqual(["announce", "teardown", "onDead"]);
  });

  it("runs onDead even when teardown throws, then propagates", () => {
    const order: string[] = [];
    expect(() =>
      runLaneDeath(
        () => {
          order.push("announce");
        },
        () => {
          order.push("teardown");
          throw new Error("teardown boom");
        },
        (error) => {
          order.push(`onDead:${error}`);
        },
        "pipe died",
      ),
    ).toThrow("teardown boom");
    expect(order).toEqual(["announce", "teardown", "onDead:pipe died"]);
  });
});

describe("reportLogStreamDeath", () => {
  it("dies first when the transport is down, then appends", () => {
    const order: string[] = [];
    reportLogStreamDeath({
      silenced: false,
      transportDown: true,
      die: (error) => {
        order.push(`die:${error}`);
      },
      onLogFrame: (nodeId, frame) => {
        order.push(`append:${nodeId}:${frame.kind}`);
      },
      nodeId: "fast",
      error: new Error("EPIPE"),
    });
    expect(order).toEqual([
      "die:log stream died (fast): EPIPE",
      "append:fast:append",
    ]);
  });

  it("does not die the lane on an isolated stream fault", () => {
    let died = false;
    let appended = false;
    reportLogStreamDeath({
      silenced: false,
      transportDown: false,
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
    expect(appended).toBe(true);
  });

  it("absorbs a sealed-log throw from the note, not a genuine handler bug", () => {
    expect(() =>
      reportLogStreamDeath({
        silenced: false,
        transportDown: false,
        die: () => {
          throw new Error("die must not run");
        },
        onLogFrame: (nodeId) => {
          throw sealed(nodeId);
        },
        nodeId: "fast",
        error: new Error("EPIPE"),
      }),
    ).not.toThrow();

    expect(() =>
      reportLogStreamDeath({
        silenced: false,
        transportDown: false,
        die: () => undefined,
        onLogFrame: () => {
          throw new Error("handler boom");
        },
        nodeId: "fast",
        error: new Error("EPIPE"),
      }),
    ).toThrow("handler boom");
  });

  it("lets a throw from die propagate — it is not absorbed", () => {
    expect(() =>
      reportLogStreamDeath({
        silenced: false,
        transportDown: true,
        die: () => {
          throw new Error("onDead boom");
        },
        onLogFrame: () => {
          throw new Error("must not run");
        },
        nodeId: "slow",
        error: new Error("EPIPE"),
      }),
    ).toThrow("onDead boom");
  });

  it("is a no-op when the lane is already quiet", () => {
    let died = false;
    let appended = false;
    reportLogStreamDeath({
      silenced: true,
      transportDown: true,
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
});
