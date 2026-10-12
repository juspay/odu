/**
 * `odu run`'s verdict grid is drawn from the frame that says the run is done,
 * never from the node stream's opening snapshot.
 *
 * Measured on a Cloudflare lane: `run.wait` answered `settled, passed` from the
 * journal and `odu run` exited 0, but the grid beside it was drawn from a
 * snapshot that still had the last node running — `▶ default running … —
 * RUNNING`, an exit and a summary that disagreed.
 */

import { describe, expect, it } from "bun:test";
import { Effect, Stream } from "effect";
import type { NodesFrame, OduServiceClient } from "@odu/service-client/surface";
import { verdictFrame } from "./serviceFace";

function frame(status: "running" | "ok", done: boolean): NodesFrame {
  return {
    order: ["default@x86_64-linux"],
    nodes: [
      {
        id: "default@x86_64-linux",
        status,
        attempt: 1,
        exitCode: status === "ok" ? 0 : null,
        startedAt: 1,
        durationMs: status === "ok" ? 60_000 : null,
        host: "cloudflare:w",
        logKey: "k",
      },
    ],
    state: done ? "settled" : "still_running",
    env: { phase: "lanes", elapsedMs: 1, lanes: [], hostsSource: null, commitUrl: null, owed: [] },
    done,
  } as unknown as NodesFrame;
}

/** A service whose `nodes.get` answers each subscription with the next script. */
function scripted(...subscriptions: Stream.Stream<NodesFrame>[]) {
  let opened = 0;
  const client = {
    surface: {
      nodes: {
        get: () => subscriptions[Math.min(opened++, subscriptions.length - 1)]!,
      },
    },
  } as unknown as Pick<OduServiceClient, "surface">;
  return { client, opened: () => opened };
}

describe("verdictFrame", () => {
  it("skips a stale opening snapshot and returns the frame that says done", async () => {
    const { client } = scripted(
      Stream.concat(Stream.make(frame("running", false)), Stream.fromEffect(Effect.sleep("50 millis").pipe(Effect.as(frame("ok", true))))),
    );
    const got = await verdictFrame(client, "r", 5_000);
    expect(got?.done).toBe(true);
    expect(got?.nodes[0]?.status).toBe("ok");
  });

  it("re-subscribes when the stream ends before saying done", async () => {
    const { client, opened } = scripted(Stream.make(frame("running", false)), Stream.make(frame("ok", true)));
    const got = await verdictFrame(client, "r", 5_000);
    expect(got?.done).toBe(true);
    expect(opened()).toBe(2);
  });

  it("is bounded: a stream that never says done yields its last frame, not done", async () => {
    const { client } = scripted(Stream.concat(Stream.make(frame("running", false)), Stream.never));
    const t0 = Date.now();
    const got = await verdictFrame(client, "r", 300);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(got?.done).toBe(false);
  });
});
