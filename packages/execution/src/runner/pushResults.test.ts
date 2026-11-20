import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushOptions, PushSummary } from "@odu/cache/push";
import {
  createLanePusher,
  type LanePusher,
  pushConfigOf,
  pushEnvFor,
  resultPathsIn,
} from "./pushResults";

const CONFIG = { origin: "https://odu.example.org", bucket: "main", token: "odu_run" };

interface World {
  workspace: string;
  storeDir: string;
  build: (link: string, name: string) => string;
  write: (name: string) => void;
  dispose: () => void;
}

function world(): World {
  const root = mkdtempSync(join(tmpdir(), "odu-push-"));
  const storeDir = join(root, "store");
  const workspace = join(root, "work");
  mkdirSync(storeDir);
  mkdirSync(workspace);
  return {
    workspace,
    storeDir,
    build: (link, name) => {
      const target = join(storeDir, name);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "bin"), "x");
      symlinkSync(target, join(workspace, link));
      return target;
    },
    write: (name) => writeFileSync(join(workspace, name), "notes"),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

const summary = (over: Partial<PushSummary> = {}): PushSummary => ({
  pushed: 1,
  bytes: 4096,
  skippedUpstream: 0,
  skippedDerivation: [],
  mode: "direct",
  alreadyPresent: 0,
  failed: 0,
  failures: [],
  served: [],
  substituter: `${CONFIG.origin}/cache/${CONFIG.bucket}`,
  pinned: null,
  pageUrl: "https://odu.example.org/#/cache/main",
  ...over,
});

function laneWith(
  storeDir: string,
  push: (options: PushOptions) => Promise<PushSummary>,
): LanePusher {
  return createLanePusher({ storeDir, push });
}

function sinks(): {
  hooks: Parameters<LanePusher["push"]>[2];
  notes: string[];
  said: string[];
  begins: () => number;
} {
  const notes: string[] = [];
  const said: string[] = [];
  let begins = 0;
  return {
    hooks: {
      note: (line) => {
        notes.push(line);
      },
      begin: () => {
        begins += 1;
      },
      say: (line) => {
        said.push(line);
      },
    },
    notes,
    said,
    begins: () => begins,
  };
}

describe("what a lane finds to push", () => {
  it("resolves result* links to store paths, through a chain, and ignores the rest", () => {
    const w = world();
    try {
      const one = w.build("result", "aaa-one");
      w.build("result-doc", "bbb-doc");
      w.write("results.md");
      symlinkSync(join(w.workspace, "result"), join(w.workspace, "result-alias"));
      symlinkSync(join(w.storeDir, "ccc-gone"), join(w.workspace, "result-gone"));

      const found = resultPathsIn(w.workspace, w.storeDir);
      expect(found).toEqual([one, join(w.storeDir, "bbb-doc")]);
    } finally {
      w.dispose();
    }
  });

  it("THROWS for a directory that is not there, and the lane NOTES it on the recipe's log", async () => {
    expect(() => resultPathsIn("/nonexistent-workspace")).toThrow();

    const s = sinks();
    const lane = laneWith("/nix/store", async () => {
      throw new Error("the push client must never be reached");
    });
    expect(await lane.push("/nonexistent-workspace", CONFIG, s.hooks)).toBeNull();
    expect(s.notes.join("\n")).toContain("not pushing: /nonexistent-workspace");
    expect(s.said).toEqual([]);
    expect(s.begins()).toBe(0);
  });

  it("reads the push configuration off a task's environment, and only a whole one", () => {
    expect(pushConfigOf(undefined)).toBeNull();
    expect(pushConfigOf({ ODU_CACHE_ORIGIN: "https://a" })).toBeNull();
    expect(pushConfigOf({ ODU_CACHE_ORIGIN: "https://a", ODU_CACHE_BUCKET: "m" })).toBeNull();
    expect(pushConfigOf({ ODU_CACHE_TOKEN: "t" })).toBeNull();
    expect(
      pushConfigOf({
        ODU_CACHE_ORIGIN: "https://a",
        ODU_CACHE_BUCKET: "m",
        ODU_CACHE_TOKEN: "",
      }),
    ).toBeNull();
    expect(
      pushConfigOf({
        ODU_CACHE_ORIGIN: "https://a",
        ODU_CACHE_BUCKET: "m",
        ODU_CACHE_TOKEN: "t",
      }),
    ).toEqual({ origin: "https://a", bucket: "m", token: "t" });
  });

  it("round-trips the pin and the provenance, and omits what the coordinator did not state", () => {
    const full = {
      origin: "https://a",
      bucket: "m",
      token: "t",
      pin: "acme/widget@main/x86_64-linux",
      run: "0000000f-0001",
      commit: "c0ffee",
    };
    expect(pushConfigOf(pushEnvFor(full))).toEqual(full);
    expect(pushEnvFor(null)).toEqual({});
    expect(
      pushEnvFor({ origin: "https://a", bucket: "m", token: "t" }),
    ).toEqual({
      ODU_CACHE_ORIGIN: "https://a",
      ODU_CACHE_BUCKET: "m",
      ODU_CACHE_TOKEN: "t",
    });
  });
});

describe("a lane that pushes", () => {
  it("sends a store path once, and the next node reports nothing", async () => {
    const w = world();
    try {
      const one = w.build("result", "aaa-one");
      const sent: PushOptions[] = [];
      const lane = laneWith(w.storeDir, async (options) => {
        sent.push(options);
        return summary({ served: [...options.paths] });
      });

      const s = sinks();
      const first = await lane.push(w.workspace, CONFIG, s.hooks);
      expect(first).toEqual({ stored: 1, present: 0, bytes: 4096 });
      expect(s.begins()).toBe(1);
      expect(s.said.join("\n")).toContain("pushing 1 result path to bucket main");
      expect(s.notes).toEqual([]);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.paths).toEqual([one]);
      expect(sent[0]).toMatchObject({ bucket: CONFIG.bucket, origin: CONFIG.origin });
      expect(sent[0]?.credential).toBe(CONFIG.token);
      expect(sent[0]?.env).toEqual({});

      const again = sinks();
      const second = await lane.push(w.workspace, CONFIG, again.hooks);
      expect(second).toBeNull();
      expect(sent).toHaveLength(1);
      expect(again.begins()).toBe(0);
      expect(again.said).toEqual([]);
    } finally {
      w.dispose();
    }
  });

  it("pushes only what is NEW when a later node builds something more", async () => {
    const w = world();
    try {
      w.build("result", "aaa-one");
      const sent: PushOptions[] = [];
      const lane = laneWith(w.storeDir, async (options) => {
        sent.push(options);
        return summary({ served: [...options.paths] });
      });
      await lane.push(w.workspace, CONFIG, sinks().hooks);
      const second = w.build("result-doc", "bbb-doc");
      await lane.push(w.workspace, CONFIG, sinks().hooks);
      expect(sent).toHaveLength(2);
      expect(sent[1]?.paths).toEqual([second]);
    } finally {
      w.dispose();
    }
  });

  it("tells what it STORED apart from what the bucket already had", async () => {
    const w = world();
    try {
      w.build("result", "aaa-one");
      const lane = laneWith(w.storeDir, async (options) =>
        summary({ pushed: 1, alreadyPresent: 3, bytes: 4096, served: [...options.paths] }),
      );
      expect(await lane.push(w.workspace, CONFIG, sinks().hooks)).toEqual({
        stored: 1,
        present: 3,
        bytes: 4096,
      });
    } finally {
      w.dispose();
    }
  });

  it("names the bucket and the origin when the SEND ITSELF rejects, and keeps the cause", async () => {
    const w = world();
    try {
      w.build("result", "aaa-one");
      const dial = Object.assign(
        new TypeError("Unable to connect. Is the computer able to access the url?"),
        { code: "ECONNREFUSED" },
      );
      const lane = laneWith(w.storeDir, async () => {
        throw dial;
      });
      const s = sinks();
      const thrown = await lane
        .push(w.workspace, CONFIG, s.hooks)
        .then(() => null)
        .catch((err: unknown) => err);
      expect(s.begins()).toBe(1);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain(CONFIG.bucket);
      expect((thrown as Error).message).toContain(CONFIG.origin);
      expect((thrown as Error).cause).toBe(dial);
    } finally {
      w.dispose();
    }
  });

  it("throws when the bucket refused a path, naming it AND where it was refused", async () => {
    const w = world();
    try {
      w.build("result", "aaa-one");
      const lane = laneWith(w.storeDir, async () =>
        summary({
          failed: 1,
          failures: [
            {
              path: "/store/aaa-one",
              message: "413 too large",
              attempts: [
                {
                  message: "PUT refused: 413 too large",
                  url: "https://odu.example.org/cache/main/nar/aaa-one",
                  status: 413,
                  body: "object exceeds the part limit",
                },
              ],
            },
          ],
          served: [],
        }),
      );
      const s = sinks();
      const thrown = await lane
        .push(w.workspace, CONFIG, s.hooks)
        .then(() => null)
        .catch((err: unknown) => err);
      expect(s.begins()).toBe(1);
      expect(thrown).toBeInstanceOf(Error);
      const said = (thrown as Error).message;
      expect(said).toContain("413 too large");
      expect(said).toContain("main");
      expect(said).toContain("https://odu.example.org/cache/main/nar/aaa-one");
      expect(said).toContain("413");
      expect(said).toContain("object exceeds the part limit");
    } finally {
      w.dispose();
    }
  });

  it("does not re-send a path the bucket already serves, even when a sibling was refused", async () => {
    const w = world();
    try {
      const one = w.build("result", "aaa-one");
      const sent: PushOptions[] = [];
      let refuse = true;
      const lane = laneWith(w.storeDir, async (options) => {
        sent.push(options);
        const answer = refuse
          ? summary({
              failed: 1,
              failures: [
                {
                  path: "/store/zzz-dep",
                  message: "refused",
                  attempts: [
                    { message: "refused", url: null, status: null, body: null },
                  ],
                },
              ],
              served: [one],
            })
          : summary({ served: [...options.paths] });
        return answer;
      });
      await lane.push(w.workspace, CONFIG, sinks().hooks).catch(() => {});
      refuse = false;
      expect(await lane.push(w.workspace, CONFIG, sinks().hooks)).toBeNull();
      expect(sent).toHaveLength(1);
    } finally {
      w.dispose();
    }
  });
});

describe("a lane that was handed a pin", () => {
  const client =
    (sent: PushOptions[], over: Partial<PushSummary> = {}) =>
    async (options: PushOptions): Promise<PushSummary> => {
      sent.push(options);
      const failures = over.failures ?? [];
      return summary({
        served: [...options.paths],
        ...over,
        pinned:
          options.pin === undefined || failures.length > 0
            ? null
            : { name: options.pin, rootPaths: options.paths.length },
      });
    };

  it("pins, and carries the run and the commit, when every path landed", async () => {
    const w = world();
    try {
      const one = w.build("result", "aaa-one");
      const sent: PushOptions[] = [];
      const lane = laneWith(w.storeDir, client(sent));
      const s = sinks();
      await lane.push(
        w.workspace,
        { ...CONFIG, pin: "acme/widget@main/x86_64-linux", run: "0000000f-0001", commit: "c0ffee" },
        s.hooks,
      );
      expect(sent[0]?.paths).toEqual([one]);
      expect(sent[0]?.pin).toBe("acme/widget@main/x86_64-linux");
      expect(sent[0]?.run).toBe("0000000f-0001");
      expect(sent[0]?.commit).toBe("c0ffee");
    } finally {
      w.dispose();
    }
  });

  it("leaves the pin unmade when a path was refused — the client's rule, not the lane's", async () => {
    const w = world();
    try {
      w.build("result", "aaa-one");
      const sent: PushOptions[] = [];
      const refusal = {
        path: "/store/zzz-dep",
        message: "413 too large",
        attempts: [{ message: "413 too large", url: null, status: null, body: null }],
      };
      const lane = laneWith(
        w.storeDir,
        client(sent, { failed: 1, failures: [refusal], served: [] }),
      );
      const thrown = await lane
        .push(w.workspace, { ...CONFIG, pin: "acme/widget@main/x86_64-linux" }, sinks().hooks)
        .then(() => null)
        .catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(Error);
      expect(sent[0]?.pin).toBe("acme/widget@main/x86_64-linux");
    } finally {
      w.dispose();
    }
  });

  it("names its WHOLE result set, even paths an earlier node already sent", async () => {
    const w = world();
    try {
      const one = w.build("result", "aaa-one");
      const sent: PushOptions[] = [];
      const lane = laneWith(w.storeDir, client(sent));
      await lane.push(w.workspace, CONFIG, sinks().hooks);
      expect(sent).toHaveLength(1);

      const s = sinks();
      const pinned = await lane.push(
        w.workspace,
        { ...CONFIG, pin: "acme/widget@main/x86_64-linux" },
        s.hooks,
      );
      expect(sent).toHaveLength(2);
      expect(sent[1]?.paths).toEqual([one]);
      expect(s.begins()).toBe(1);
      expect(pinned).not.toBeNull();
    } finally {
      w.dispose();
    }
  });
});
