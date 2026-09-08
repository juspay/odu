/**
 * The TUI's log pane, driven against a scripted service.
 *
 * `odu attach`'s pane and `odu logs -f` read the same verb through the same
 * three facts, and for a while they disagreed about what those facts mean. The
 * pane ended on `!open` alone, which is the loss `followLog.test.ts` documents
 * for the CLI, arriving one layer over: a read is bounded, so a producer that
 * finishes after appending more than one page hands back a page with
 * `open: false` and unread bytes behind it. The pane drew the first of them and
 * closed.
 *
 * That is the whole diagnosis a person opened the pane to read, thrown away.
 * Both faces call `logHasMore` now, and this is the assertion that says so for
 * this one — including the reviewer's own probe, which is the first case below.
 */

import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { LogPage, OduServiceClient } from "@odu/service-client/surface";
import { ServiceRefused } from "@odu/service-client/surface";
import { subscribe } from "@odu/execution/common/effectEdge";
import type { NodeLogFrame } from "@odu/run-client/surface";
import { nodeLogStream } from "./liveFromService";

const KEY = "0mtr-abc/ci~3A~3Aunit~40x86_64-linux/1";

type ReadInput = { key: string; offset?: number; waitMs?: number };

/** A service answering `log.read` from a script, recording what it was asked —
 *  the recorded offsets are the cursor's whole story. */
function scripted(pages: readonly (LogPage | ServiceRefused)[]): {
  client: Pick<OduServiceClient, "surface">;
  asked: ReadInput[];
} {
  const asked: ReadInput[] = [];
  let at = 0;
  const client = {
    surface: {
      log: {
        read: (input: ReadInput) => {
          asked.push(input);
          const next = pages[at];
          at += 1;
          if (next === undefined) {
            return Effect.fail(
              new ServiceRefused({ code: "bad_input", message: "script ran out" }),
            );
          }
          return next instanceof ServiceRefused
            ? Effect.fail(next)
            : Effect.succeed(next);
        },
      },
    },
  } as unknown as Pick<OduServiceClient, "surface">;
  return { client, asked };
}

function page(over: Partial<LogPage> & Pick<LogPage, "text" | "offset">): LogPage {
  const size = over.size ?? over.offset + over.text.length;
  return {
    key: KEY,
    size,
    nextOffset: over.nextOffset ?? over.offset + over.text.length,
    eof: over.eof ?? over.offset + over.text.length >= size,
    complete: over.complete ?? true,
    open: over.open ?? false,
    ...over,
  } as LogPage;
}

/** Every frame the pane would draw, in order. */
async function frames(
  client: Pick<OduServiceClient, "surface">,
): Promise<NodeLogFrame[]> {
  const seen: NodeLogFrame[] = [];
  for await (const frame of subscribe(nodeLogStream(client, KEY))) {
    seen.push(frame);
    if (frame.kind === "end") break;
  }
  return seen;
}

describe("the TUI's log pane", () => {
  it("drains a closed log that still has unread bytes", async () => {
    // THE REPRODUCTION, verbatim: the first page says the log can no longer
    // grow and that this read did not reach its end. Ending there made one
    // call, emitted FIRST, and closed — losing FINAL, which is the line
    // somebody opened the pane for.
    const { client, asked } = scripted([
      page({ text: "FIRST", offset: 0, size: 10, open: false, eof: false }),
      page({ text: "FINAL", offset: 5, size: 10, open: false, eof: true }),
    ]);

    const seen = await frames(client);

    expect(asked).toHaveLength(2);
    expect(asked[1]?.offset).toBe(5);
    expect(seen.map((f) => f.kind)).toEqual(["snapshot", "append", "end"]);
    expect(seen.map((f) => ("text" in f ? f.text : "")).join("")).toBe(
      "FIRSTFINAL",
    );
  });

  it("ends once the log is closed AND read to its end", async () => {
    const { client, asked } = scripted([
      page({ text: "all of it", offset: 0, open: false, eof: true }),
    ]);

    const seen = await frames(client);

    // One read, because there was nothing else to ask for.
    expect(asked).toHaveLength(1);
    expect(seen.map((f) => f.kind)).toEqual(["snapshot", "end"]);
  });

  it("keeps following a log that is still open at its end", async () => {
    // `eof` with `open` is the ordinary live case: caught up, and more coming.
    // A pane that stopped here would go blank on every quiet moment.
    const { client } = scripted([
      page({ text: "so far", offset: 0, open: true, eof: true }),
      page({ text: " and more", offset: 6, open: false, eof: true }),
    ]);

    const seen = await frames(client);

    expect(seen.map((f) => f.kind)).toEqual(["snapshot", "append", "end"]);
    expect(seen.map((f) => ("text" in f ? f.text : "")).join("")).toBe(
      "so far and more",
    );
  });

  it("starts over when the attempt was re-run underneath it", async () => {
    // A rerun rewrites the log in place, so the file can be SHORTER than the
    // cursor. `snapshot` is what tells the pane to replace rather than append —
    // appending would show the tail of a different attempt as a continuation of
    // this one.
    const { client, asked } = scripted([
      page({ text: "old output", offset: 0, open: true, eof: true }),
      // Shorter than the cursor: the read clamped, and the offset coming back
      // BELOW what was asked for is the only signal a rewrite happened. This
      // page is discarded and the cursor reset, so the next read is the one
      // whose bytes reach the pane.
      page({ text: "ignored", offset: 0, size: 3, open: true, eof: true }),
      page({ text: "new", offset: 0, size: 3, open: false, eof: true }),
    ]);

    const seen = await frames(client);

    expect(asked.map((a) => a.offset)).toEqual([undefined, 10, 0]);
    // TWO snapshots, and the second is the point: `snapshot` tells the pane to
    // REPLACE, so the rewritten log shows as itself rather than as more of the
    // old one. An `append` here would read as one attempt's output twice.
    expect(seen.map((f) => f.kind)).toEqual(["snapshot", "snapshot", "end"]);
    const last = seen.filter((f) => f.kind === "snapshot").at(-1);
    expect(last !== undefined && "text" in last ? last.text : "").toBe("new");
  });
});
