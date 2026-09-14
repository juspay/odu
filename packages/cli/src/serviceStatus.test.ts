/**
 * `odu status`, `odu attach` and `--run <address>` — resolved through ONE
 * bounded `run.list`, against a scripted service.
 *
 * These faces used to read the whole board a row per round trip and filter it
 * here, with nothing bounding the wait and nothing on screen while it lasted;
 * on a 710-run catalog `odu attach` sat blank for minutes (juspay/odu#113).
 * What is pinned below is the part a scripted service can state on cue: which
 * query each face sends, what it makes of the one row that comes back, and
 * what it says when the service accepts the call and then answers nothing.
 *
 * Stand-ins cannot see a wrong cast on the wire — `serviceFace.ts`'s history
 * says so twice — which is why `tests/e2e/catalog-scale.e2e.test.ts` drives the
 * same commands against the real binary.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Stream } from "effect";
import type {
  ListInput,
  NodesFrame,
  OduServiceClient,
  RunRow,
} from "@odu/service-client/surface";
import { attachWith, statusWith } from "./serviceStatus";
import { git, parseRunAddress, patience, resolveRunAddress, watchNodes } from "./serviceFace";

const CHECKOUT = "/code/app";

function row(over: Partial<RunRow> = {}): RunRow {
  return {
    runId: "0mtr00000-00000001",
    repo: null,
    repoRoot: CHECKOUT,
    branch: "main",
    sha: "a".repeat(40),
    dirty: false,
    seq: 1,
    pipeline: "ci",
    createdAt: 1_700_000_000_000,
    state: "settled",
    settled: true,
    passed: true,
    outcome: "passed",
    actionable: false,
    unresolvedFailures: 0,
    scope: { selectors: [], platforms: [], noDeps: false },
    reportingDebt: 0,
    endpoint: null,
    parentRunId: null,
    cursor: "0mtr00000-00000001@1",
    ...over,
  } as RunRow;
}

function frame(over: Partial<NodesFrame> = {}): NodesFrame {
  return {
    order: ["unit@x86_64-linux"],
    nodes: [
      {
        id: "unit@x86_64-linux",
        status: "ok",
        attempt: 1,
        exitCode: 0,
        startedAt: 1,
        durationMs: 5,
        host: "localhost",
        logKey: "k",
      },
    ],
    state: "settled",
    env: {
      phase: "lanes",
      elapsedMs: 5,
      lanes: [],
      hostsSource: null,
      commitUrl: null,
      owed: [],
    },
    done: true,
    ...over,
  } as NodesFrame;
}

/** A service answering `run.list` with `rows` (filtered by nothing — the
 *  script IS the answer) and `nodes.get` with `nodes`, recording each query
 *  and counting each node-stream subscription. */
function scripted(opts: {
  rows?: readonly RunRow[];
  nodes?: Stream.Stream<NodesFrame>;
}): {
  client: Pick<OduServiceClient, "surface">;
  asked: ListInput[];
  opened: () => number;
} {
  const asked: ListInput[] = [];
  let subscriptions = 0;
  const rows = opts.rows ?? [];
  const client = {
    surface: {
      run: {
        list: (input: ListInput) => {
          asked.push(input);
          return Effect.succeed({
            rows: rows.slice(0, input.limit ?? rows.length),
            total: rows.length,
          });
        },
      },
      nodes: {
        get: () => {
          subscriptions += 1;
          return opts.nodes ?? Stream.make(frame());
        },
      },
    },
  } as unknown as Pick<OduServiceClient, "surface">;
  return { client, asked, opened: () => subscriptions };
}

async function captured(
  body: () => Promise<number>,
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
    const code = await body();
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

/** Quiet patience: no tty, so no waiting line unless a test asks for one. */
const quiet = (json = false, deadlineMs?: number) =>
  patience("http://127.0.0.1:1", json, {
    tty: false,
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  });

describe("odu status through run.list", () => {
  it("asks for exactly this checkout's newest run, in one call", async () => {
    const { client, asked } = scripted({ rows: [row()] });
    const { code, out } = await captured(() => statusWith(client, CHECKOUT, quiet()));
    expect(asked).toEqual([{ checkout: CHECKOUT, limit: 1 }]);
    expect(code).toBe(0);
    expect(out).toContain("unit@x86_64-linux");
  });

  it("answers a checkout with no run as an ordinary exit 0", async () => {
    const { client } = scripted({ rows: [] });
    const { code, out } = await captured(() => statusWith(client, CHECKOUT, quiet()));
    expect(code).toBe(0);
    expect(out).toBe("no run in flight for this checkout\n");
  });

  it("has nothing to show when the newest run has expired", async () => {
    // Not "fall back to an older run": the newest is the one that happened
    // here last, and retention having taken its evidence is the answer.
    const { client } = scripted({
      rows: [row({ state: "expired" }), row({ runId: "older" })],
    });
    const { code, out } = await captured(() => statusWith(client, CHECKOUT, quiet(true)));
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ run: null, nodes: [], posting: { owed: [] } });
  });

  it("shows an owner_lost newest run and exits 3", async () => {
    const { client } = scripted({
      rows: [row({ state: "owner_lost", settled: false, passed: false, outcome: null })],
    });
    const { code, out } = await captured(() => statusWith(client, CHECKOUT, quiet()));
    expect(code).toBe(3);
    expect(out).toContain("unit@x86_64-linux");
  });

  it("exits 1 for a settled red run", async () => {
    const { client } = scripted({
      rows: [row({ passed: false, outcome: "failed", unresolvedFailures: 1 })],
    });
    const { code } = await captured(() => statusWith(client, CHECKOUT, quiet()));
    expect(code).toBe(1);
  });

  it("reports a first nodes frame that never comes, bounded, as exit 3", async () => {
    // The service is there and silent — the #113 shape. Before, nothing
    // bounded this and the terminal stayed blank.
    const { client } = scripted({ rows: [row()], nodes: Stream.never });
    const { code, err } = await captured(() =>
      statusWith(client, CHECKOUT, quiet(false, 30)),
    );
    expect(code).toBe(3);
    expect(err).toContain("did not answer");
    expect(err).toContain("http://127.0.0.1:1");
  });

  it("reports a listing that never comes the same way, and in JSON as JSON", async () => {
    const client = {
      surface: { run: { list: () => Effect.never } },
    } as unknown as Pick<OduServiceClient, "surface">;
    const { code, out } = await captured(() =>
      statusWith(client, CHECKOUT, quiet(true, 30)),
    );
    expect(code).toBe(3);
    expect(JSON.parse(out).error).toBe("no_answer");
  });
});

describe("odu attach through run.list", () => {
  it("bounds the first frame of the follow, and reports it as exit 3", async () => {
    const { client } = scripted({ rows: [row()], nodes: Stream.never });
    const { code, err } = await captured(() =>
      attachWith(client, CHECKOUT, quiet(false, 30), { live: null }),
    );
    expect(code).toBe(3);
    expect(err).toContain("did not answer");
  });

  it("bounds the matrix's first frame the same way, before it paints", async () => {
    const { client } = scripted({ rows: [row()], nodes: Stream.never });
    let painted = false;
    const { code, err } = await captured(() =>
      attachWith(client, CHECKOUT, quiet(false, 30), {
        // What `attachLive` does with the patience it is handed.
        live: async (c, r, p) => {
          await watchNodes(c, r.runId, () => {
            painted = true;
          }, { patience: p });
          return 0;
        },
      }),
    );
    expect(code).toBe(3);
    expect(err).toContain("did not answer");
    // The matrix never painted on a service that had not answered.
    expect(painted).toBe(false);
  });

  it("opens the node stream ONCE, and follows it", async () => {
    // Not a probe and then the follow: the bound rides the subscription that is
    // kept, so a service that answers a probe and stalls on the second
    // subscription cannot leave the terminal blank.
    const { client, opened } = scripted({ rows: [row()] });
    const { code, out } = await captured(() =>
      attachWith(client, CHECKOUT, quiet(true), { live: null }),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ run: row().runId, done: true });
    expect(opened()).toBe(1);
  });

  it("says there is no run, on stderr, and exits 0", async () => {
    const { client } = scripted({ rows: [] });
    const { code, err } = await captured(() =>
      attachWith(client, CHECKOUT, quiet(), { live: null }),
    );
    expect(code).toBe(0);
    expect(err).toContain("no run in flight");
  });
});

describe("the waiting line", () => {
  it("appears once, after the threshold, when a person is watching", async () => {
    const lines: string[] = [];
    const p = patience("http://127.0.0.1:1", false, {
      tty: true,
      afterMs: 10,
      write: (text) => lines.push(text),
    });
    const slow = <T>(value: T) =>
      new Promise<T>((resolve) => setTimeout(() => resolve(value), 40));
    expect(await p.notice(slow(1))).toBe(1);
    expect(await p.notice(slow(2))).toBe(2);
    expect(lines).toEqual(["odu: waiting for the service at http://127.0.0.1:1…\n"]);
  });

  it("stays silent for a fast answer, under JSON, and into a pipe", async () => {
    const lines: string[] = [];
    const write = (text: string) => lines.push(text);
    const slow = new Promise((resolve) => setTimeout(resolve, 40));
    await patience("o", false, { tty: true, afterMs: 1_000, write }).notice(slow);
    await patience("o", true, { tty: true, afterMs: 1, write }).notice(
      new Promise((resolve) => setTimeout(resolve, 40)),
    );
    await patience("o", false, { tty: false, afterMs: 1, write }).notice(
      new Promise((resolve) => setTimeout(resolve, 40)),
    );
    expect(lines).toEqual([]);
  });
});

describe("resolveRunAddress through run.list", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "odu-address-"));
    dirs.push(dir);
    return dir;
  };

  it("passes a run id through without asking the service", async () => {
    const { client, asked } = scripted({ rows: [row()] });
    const resolved = await resolveRunAddress(client, "0mtr-abc", "/", quiet());
    expect(resolved).toEqual({ ok: true, value: "0mtr-abc" });
    expect(asked).toEqual([]);
  });

  it("resolves `latest` as THIS checkout's newest run", async () => {
    const repo = tmp();
    expect(git(["init", "-q"], repo)).not.toBeNull();
    const top = git(["rev-parse", "--show-toplevel"], repo) as string;
    const { client, asked } = scripted({ rows: [row({ runId: "newest" })] });
    const resolved = await resolveRunAddress(client, "latest", repo, quiet());
    expect(resolved).toEqual({ ok: true, value: "newest" });
    expect(asked).toEqual([{ checkout: top, limit: 1 }]);
  });

  it("resolves `<sha7>#<seq>` globally, newest first", async () => {
    const { client, asked } = scripted({ rows: [row({ runId: "by-ref" })] });
    const resolved = await resolveRunAddress(client, "AbCdEf1#2", "/", quiet());
    expect(resolved).toEqual({ ok: true, value: "by-ref" });
    expect(asked).toEqual([{ sha: "AbCdEf1", seq: 2, limit: 1 }]);
  });

  it("parses the grammar once, without a client", () => {
    expect(parseRunAddress("latest")).toEqual({ kind: "latest" });
    expect(parseRunAddress("0mtr-abc")).toEqual({ kind: "id", runId: "0mtr-abc" });
    expect(parseRunAddress("#3")).toEqual({ kind: "id", runId: "#3" });
    expect(parseRunAddress("AbCdEf1#2")).toEqual({ kind: "ref", sha: "AbCdEf1", seq: 2 });
    for (const bad of ["abc#2", "abcdef1#x", "abcdef1#0", "abcdef1#1.5"]) {
      expect(parseRunAddress(bad)).toEqual({ kind: "malformed" });
    }
  });

  it("exits 4 for an address nothing matches, or that cannot name a run", async () => {
    const { client, asked } = scripted({ rows: [] });
    for (const address of ["abcdef1#2", "abc#2", "abcdef1#x"]) {
      const { code, out } = await captured(async () => {
        const resolved = await resolveRunAddress(client, address, "/", quiet(true));
        return resolved.ok ? 0 : resolved.exit;
      });
      expect(code).toBe(4);
      expect(JSON.parse(out)).toMatchObject({ error: "unknown_run", run: address });
    }
    // Only the well-formed ref was worth a round trip.
    expect(asked).toEqual([{ sha: "abcdef1", seq: 2, limit: 1 }]);

    const outside = tmp();
    const { code } = await captured(async () => {
      const resolved = await resolveRunAddress(client, "latest", outside, quiet());
      return resolved.ok ? 0 : resolved.exit;
    });
    expect(code).toBe(4);
  });
});
