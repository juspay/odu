/**
 * `odu logs -f` — the loop, driven against a scripted service.
 *
 * The loop is what has a contract, so it is split from the dial and tested
 * without one: a `log.read` that answers from a queue can state "the log grew,
 * then finished", "the writer was killed", "the attempt was re-run underneath
 * you" at exactly the moment each matters, which a real service cannot be asked
 * to do on cue.
 *
 * ## The bug this exists because of
 *
 * There was no test here at all, and the loop stopped on `open` alone. A page
 * is bounded by `limit` — 12 KiB by default — so a log that is ALREADY closed
 * comes back `eof: false, open: false` on its very first page. The loop printed
 * that one page and exited **0**, dropping every byte after it, while the usage
 * text and the docs both promise "exits 0 with the whole log". Reading a
 * fifty-kilobyte failure gave you the first twelve kilobytes and a successful
 * exit.
 *
 * Both halves of that are asserted below: the bytes, and the exit.
 */

import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { LogPage, OduServiceClient } from "@odu/service-client/surface";
import { ServiceRefused } from "@odu/service-client/surface";
import { followLog } from "./serviceCommands";

const KEY = "0mtr-abc/ci~3A~3Aunit~40x86_64-linux/1";

type ReadInput = { key: string; offset?: number; limit?: number; waitMs?: number };

/** A service that answers `log.read` from a script, and records what it was
 *  asked. The recorded inputs are the cursor's whole story. */
function scripted(
  pages: readonly (LogPage | ServiceRefused)[],
): { client: Pick<OduServiceClient, "surface">; asked: ReadInput[] } {
  const asked: ReadInput[] = [];
  let at = 0;
  const client = {
    surface: {
      log: {
        read: (input: ReadInput) => {
          asked.push(input);
          const next = pages[Math.min(at, pages.length - 1)];
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

/** Capture what the follow put on stdout, and its exit. */
async function follow(
  client: Pick<OduServiceClient, "surface">,
  opts: Parameters<typeof followLog>[1],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  // A narrow, restored-in-finally stub of the two sinks — the only way to make
  // "what did the follow put on stdout" assertable without a subprocess.
  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await followLog(client, opts);
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

describe("followLog", () => {
  it("drains a CLOSED log that is longer than one page", async () => {
    // THE REGRESSION. Both pages are `open: false` — the log finished before
    // the follow began — and the first is not at EOF. Stopping on `open` alone
    // printed "aaaa" and exited 0.
    const { client, asked } = scripted([
      page({ text: "aaaa", offset: 0, size: 8, nextOffset: 4, eof: false, open: false }),
      page({ text: "bbbb", offset: 4, size: 8, nextOffset: 8, eof: true, open: false }),
    ]);

    const { code, out } = await follow(client, { key: KEY, json: false });

    expect(out).toBe("aaaabbbb");
    expect(code).toBe(0);
    // And the cursor walked: the second call resumed at the first's nextOffset.
    expect(asked.map((a) => a.offset)).toEqual([undefined, 4]);
  });

  it("follows a live log until it closes", async () => {
    const { client, asked } = scripted([
      page({ text: "one\n", offset: 0, size: 4, eof: true, open: true, complete: false }),
      page({ text: "", offset: 4, size: 4, eof: true, open: true, complete: false }),
      page({ text: "two\n", offset: 4, size: 8, eof: true, open: false, complete: true }),
    ]);

    const { code, out } = await follow(client, { key: KEY, json: false });

    expect(out).toBe("one\ntwo\n");
    expect(code).toBe(0);
    // Every call carries a deadline — that is what makes it a follow rather
    // than a poll — and every one after the first carries the held cursor.
    expect(asked.every((a) => a.waitMs !== undefined)).toBe(true);
    expect(asked.map((a) => a.offset)).toEqual([undefined, 4, 4]);
  });

  it("exits 1 and says so when the log is closed but truncated", async () => {
    // The killed writer. Exiting 0 here would hand back a log that stops
    // mid-sentence as a complete one — the one forbidden outcome.
    const { client } = scripted([
      page({ text: "half a li", offset: 0, size: 9, eof: true, open: false, complete: false }),
    ]);

    const { code, out, err } = await follow(client, { key: KEY, json: false });

    expect(out).toBe("half a li");
    expect(code).toBe(1);
    expect(err).toContain("truncated");
  });

  it("restarts from the beginning when the attempt was re-run underneath it", async () => {
    // A rerun rewrites an attempt's log in place, so the file can be SHORTER
    // than the cursor. The read clamps, and `offset < what we asked for` is the
    // only signal. Silently resuming would print the tail of a different
    // attempt as a continuation of this one.
    const { client, asked } = scripted([
      page({ text: "old bytes", offset: 0, size: 9, eof: true, open: true, complete: false }),
      page({ text: "", offset: 3, size: 3, eof: true, open: true, complete: false }),
      page({ text: "new", offset: 0, size: 3, eof: true, open: false, complete: true }),
    ]);

    const { code, out, err } = await follow(client, { key: KEY, json: false });

    expect(code).toBe(0);
    expect(out).toContain("new");
    expect(err).toContain("re-run");
    // Said ONCE, not on every subsequent page.
    expect(err.match(/re-run/g)?.length).toBe(1);
    expect(asked.map((a) => a.offset)).toEqual([undefined, 9, 0]);
  });

  it("reports a dead link as lost rather than as a finished log", async () => {
    // Exit 3, not 0: a follow that ended because the service went away has not
    // delivered the whole log, and must not claim to have.
    const { client } = scripted([
      page({ text: "some", offset: 0, size: 8, eof: false, open: true, complete: false }),
      new ServiceRefused({ code: "unknown_run", message: "gone" }),
    ]);

    const { code } = await follow(client, { key: KEY, json: false });

    // A declared refusal is exit 4/5 by the shared table; either way it is not
    // 0, which is the property that matters here.
    expect(code).not.toBe(0);
  });
});
