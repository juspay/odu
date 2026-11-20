import { describe, expect, it } from "bun:test";
import { Effect } from "effect";
import type { LogPage, OduServiceClient } from "@odu/service-client/surface";
import { ServiceRefused } from "@odu/service-client/surface";
import { followLog } from "./serviceCommands";

const KEY = "0mtr-abc/ci~3A~3Aunit~40x86_64-linux/1";

type ReadInput = { key: string; offset?: number; limit?: number; waitMs?: number };

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

async function follow(
  client: Pick<OduServiceClient, "surface">,
  opts: Parameters<typeof followLog>[1],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
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
    const { client, asked } = scripted([
      page({ text: "aaaa", offset: 0, size: 8, nextOffset: 4, eof: false, open: false }),
      page({ text: "bbbb", offset: 4, size: 8, nextOffset: 8, eof: true, open: false }),
    ]);

    const { code, out } = await follow(client, { key: KEY, json: false });

    expect(out).toBe("aaaabbbb");
    expect(code).toBe(0);
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
    expect(asked.every((a) => a.waitMs !== undefined)).toBe(true);
    expect(asked.map((a) => a.offset)).toEqual([undefined, 4, 4]);
  });

  it("exits 1 and says so when the log is closed but truncated", async () => {
    const { client } = scripted([
      page({ text: "half a li", offset: 0, size: 9, eof: true, open: false, complete: false }),
    ]);

    const { code, out, err } = await follow(client, { key: KEY, json: false });

    expect(out).toBe("half a li");
    expect(code).toBe(1);
    expect(err).toContain("truncated");
  });

  it("restarts from the beginning when the attempt was re-run underneath it", async () => {
    const { client, asked } = scripted([
      page({ text: "old bytes", offset: 0, size: 9, eof: true, open: true, complete: false }),
      page({ text: "", offset: 3, size: 3, eof: true, open: true, complete: false }),
      page({ text: "new", offset: 0, size: 3, eof: true, open: false, complete: true }),
    ]);

    const { code, out, err } = await follow(client, { key: KEY, json: false });

    expect(code).toBe(0);
    expect(out).toContain("new");
    expect(err).toContain("re-run");
    expect(err.match(/re-run/g)?.length).toBe(1);
    expect(asked.map((a) => a.offset)).toEqual([undefined, 9, 0]);
  });

  it("reports a dead link as lost rather than as a finished log", async () => {
    const { client } = scripted([
      page({ text: "some", offset: 0, size: 8, eof: false, open: true, complete: false }),
      new ServiceRefused({ code: "unknown_run", message: "gone" }),
    ]);

    const { code } = await follow(client, { key: KEY, json: false });

    expect(code).not.toBe(0);
  });
});
