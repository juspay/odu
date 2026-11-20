import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { stdioLink } from "@kolu/surface/links/stdio";
import { createLoopbackPair, greetLoopback } from "@kolu/surface/loopback";
import { serveOverStdio } from "@kolu/surface/peer-server";
import type { LogStream } from "@odu/run-client/nodeId";
import type { NodesSnapshot } from "@odu/run-client/surface";
import { firstFrame, runUnary, subscribe } from "../common/effectEdge";
import { type LaneClient, laneClientOver, laneSurface } from "../common/laneSurface";
import type { TaskSpec } from "../common/spec";
import { createLaneRunner } from "./runner";
import { type LanePusher, type PushConfig, type PushedFact } from "./pushResults";

const PUSH_ENV = {
  ODU_CACHE_ORIGIN: "https://odu.example.org",
  ODU_CACHE_BUCKET: "main",
  ODU_CACHE_TOKEN: "odu_run_token",
};

const PUSH_LINE = "[odu] 3 paths in the closure: 1 to push";

interface Lane {
  client: LaneClient;
  states: NodesSnapshot[];
  configure: (tasks: TaskSpec[]) => Promise<{ ok: boolean; error: string | null }>;
  logOf: (id: string, stream?: LogStream) => Promise<string>;
  rerun: (id: string) => Promise<{ ok: boolean }>;
  dispose: () => void;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function lane(pusher: LanePusher): Promise<Lane> {
  const runner = createLaneRunner({ pusher });
  const pair = createLoopbackPair();
  void serveOverStdio({
    group: runner.group,
    handlers: runner.handlers,
    transport: pair.server,
  });
  const readiness = await greetLoopback(pair);
  const link = await stdioLink({
    group: laneSurface.group,
    read: pair.client.read,
    write: pair.client.write,
    readiness,
  });
  const client = laneClientOver(link.dispatch);

  const states: NodesSnapshot[] = [];
  void (async () => {
    try {
      for await (const state of subscribe(client.surface.nodes.get(undefined))) {
        states.push(state);
      }
    } catch {
    }
  })();

  const dispose = (): void => {
    void link.dispose();
    pair.client.write.end();
    runner.dispose();
    pair.client.read.destroy();
  };
  cleanups.push(dispose);

  return {
    client,
    states,
    configure: (tasks) =>
      runUnary(
        client.surface.run.configure({
          name: "test",
          origin: null,
          sha: null,
          workspace: tmpdir(),
          tasks,
        }),
      ),
    logOf: async (id, stream = "recipe") => {
      const frame = await firstFrame(client.surface.nodeLog.get({ id, stream }));
      return frame !== undefined && frame.kind !== "end" ? frame.text : "";
    },
    rerun: (id) => runUnary(client.surface.node.rerun({ id })),
    dispose,
  };
}

const last = (l: Lane): NodesSnapshot => {
  const state = l.states.at(-1);
  if (state === undefined) throw new Error("no state yet");
  return state;
};

async function until(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const ready = (): boolean => {
    try {
      return predicate();
    } catch {
      return false;
    }
  };
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("until: timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type PushHooks = Parameters<LanePusher["push"]>[2];

function stubPusher(
  answer: (hooks: PushHooks, call: number) => Promise<PushedFact | null>,
): LanePusher & { calls: PushConfig[] } {
  const calls: PushConfig[] = [];
  return {
    calls,
    push: async (_workdir, config, hooks) => {
      calls.push(config);
      return answer(hooks, calls.length - 1);
    },
  };
}

const announce = (hooks: PushHooks): void => {
  hooks.begin();
  hooks.say(PUSH_LINE);
};

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

describe("a lane node that pushes what it built", () => {
  it("carries BOTH counts on the node, and the client's lines in the PUSH log", async () => {
    const pusher = stubPusher(async (hooks) => {
      announce(hooks);
      return { stored: 3, present: 66, bytes: 2_097_152 };
    });
    const l = await lane(pusher);
    await l.configure([
      { id: "build", command: "echo built", needs: [], env: PUSH_ENV },
    ]);
    await until(() => last(l).nodes.build?.status === "ok");

    expect(pusher.calls).toEqual([
      {
        origin: PUSH_ENV.ODU_CACHE_ORIGIN,
        bucket: PUSH_ENV.ODU_CACHE_BUCKET,
        token: PUSH_ENV.ODU_CACHE_TOKEN,
      },
    ]);
    const push = last(l).nodes.build?.push;
    expect(push?.state).toBe("pushed");
    expect(push).toMatchObject({ stored: 3, present: 66, bytes: 2_097_152 });
    expect(push?.state === "pushed" && push.durationMs).toBeGreaterThanOrEqual(0);

    const recipeLog = await l.logOf("build");
    expect(recipeLog).toContain("built");
    expect(recipeLog).not.toContain("[odu]");
    expect(await l.logOf("build", "push")).toContain(PUSH_LINE);
  });

  it("hands the pusher the pin and the provenance the coordinator stated, derived from nothing", async () => {
    const pusher = stubPusher(async (hooks) => {
      announce(hooks);
      return { stored: 1, present: 0, bytes: 4_096 };
    });
    const l = await lane(pusher);
    await l.configure([
      {
        id: "build",
        command: "echo built",
        needs: [],
        env: {
          ...PUSH_ENV,
          ODU_CACHE_PIN: "acme/widget@main/x86_64-linux",
          ODU_CACHE_RUN: "0000000f-0001",
          ODU_CACHE_COMMIT: "c0ffee",
        },
      },
    ]);
    await until(() => last(l).nodes.build?.status === "ok");
    expect(pusher.calls).toEqual([
      {
        origin: PUSH_ENV.ODU_CACHE_ORIGIN,
        bucket: PUSH_ENV.ODU_CACHE_BUCKET,
        token: PUSH_ENV.ODU_CACHE_TOKEN,
        pin: "acme/widget@main/x86_64-linux",
        run: "0000000f-0001",
        commit: "c0ffee",
      },
    ]);
  });

  it("opens `pushing` while it uploads, and the node is not green until it lands", async () => {
    const landed = Promise.withResolvers<void>();
    const pusher = stubPusher(async (hooks) => {
      announce(hooks);
      await landed.promise;
      return { stored: 1, present: 0, bytes: 10 };
    });
    const l = await lane(pusher);
    await l.configure([
      { id: "build", command: "echo built", needs: [], env: PUSH_ENV },
    ]);

    await until(() => last(l).nodes.build?.push?.state === "pushing");
    expect(last(l).nodes.build?.status).toBe("running");
    expect(last(l).nodes.build?.push).toEqual({ state: "pushing" });
    const recipeMs = last(l).nodes.build?.durationMs;
    expect(recipeMs).not.toBeNull();
    expect(recipeMs).toBeGreaterThanOrEqual(0);

    landed.resolve();
    await until(() => last(l).nodes.build?.status === "ok");
    expect(last(l).nodes.build?.push).toMatchObject({
      state: "pushed",
      stored: 1,
      present: 0,
      bytes: 10,
    });
    expect(last(l).nodes.build?.durationMs).toBe(recipeMs ?? -1);
  });

  it("goes RED when the push failed, with the push's own sentence in the PUSH log", async () => {
    const pusher = stubPusher(async (hooks) => {
      announce(hooks);
      throw new Error("odu: 1 path could not be pushed to main — 413 too large");
    });
    const l = await lane(pusher);
    await l.configure([
      { id: "build", command: "echo built", needs: [], env: PUSH_ENV },
    ]);
    await until(() => last(l).nodes.build?.status === "failed");

    const node = last(l).nodes.build;
    expect(node?.exitCode).toBe(0);
    expect(node?.push?.state).toBe("failed");
    expect(
      node?.push?.state === "failed" && node.push.durationMs,
    ).toBeGreaterThanOrEqual(0);
    expect(node?.push?.state === "failed" && node.push.message).toBe(
      "odu: 1 path could not be pushed to main — 413 too large",
    );
    expect(await l.logOf("build", "push")).toContain("413 too large");
    expect(await l.logOf("build")).not.toContain("413 too large");
  });

  it("writes the WHOLE cause chain to the push log, and the short sentence to the cell", async () => {
    const dial = Object.assign(
      new TypeError("Unable to connect. Is the computer able to access the url?"),
      { code: "ECONNREFUSED", hostname: "odu.example.org", port: 443 },
    );
    const wrapped = new Error(
      "odu: push of 1 path to bucket main at https://odu.example.org failed",
      { cause: dial },
    );
    const pusher = stubPusher(async (hooks) => {
      announce(hooks);
      throw wrapped;
    });
    const l = await lane(pusher);
    await l.configure([
      { id: "build", command: "echo built", needs: [], env: PUSH_ENV },
    ]);
    await until(() => last(l).nodes.build?.status === "failed");

    const node = last(l).nodes.build;
    expect(node?.push?.state === "failed" && node.push.message).toBe(wrapped.message);

    const log = await l.logOf("build", "push");
    expect(log).toContain("bucket main");
    expect(log).toContain("https://odu.example.org");
    expect(log).toContain("Unable to connect");
    expect(log).toContain("ECONNREFUSED");
    expect(log).toContain("odu.example.org");
  });

  it("RETRACTS the push on a rerun that finds nothing fresh", async () => {
    const pusher = stubPusher(async (hooks, call) => {
      if (call > 0) return null;
      announce(hooks);
      return { stored: 2, present: 0, bytes: 20 };
    });
    const l = await lane(pusher);
    await l.configure([
      { id: "build", command: "echo built", needs: [], env: PUSH_ENV },
    ]);
    await until(() => last(l).nodes.build?.push?.state === "pushed");

    expect(await l.rerun("build")).toEqual({ ok: true });
    await until(
      () => pusher.calls.length === 2 && last(l).nodes.build?.status === "ok",
    );
    expect(last(l).nodes.build?.push).toBeUndefined();
    expect(await l.logOf("build", "push")).toBe("");
  });

  it("RE-OPENS both logs for a rerun that pushes again", async () => {
    const pusher = stubPusher(async (hooks) => {
      announce(hooks);
      return { stored: 2, present: 0, bytes: 20 };
    });
    const l = await lane(pusher);
    await l.configure([
      { id: "build", command: "echo built", needs: [], env: PUSH_ENV },
    ]);
    await until(() => last(l).nodes.build?.push?.state === "pushed");

    expect(await l.rerun("build")).toEqual({ ok: true });
    await until(
      () => pusher.calls.length === 2 && last(l).nodes.build?.push?.state === "pushed",
    );
    expect(last(l).nodes.build?.status).toBe("ok");
    expect(occurrences(await l.logOf("build", "push"), PUSH_LINE)).toBe(1);
    expect(occurrences(await l.logOf("build"), "built")).toBe(1);
  });

  it("has NO push step when there was nothing fresh to send", async () => {
    const pusher = stubPusher(async () => null);
    const l = await lane(pusher);
    await l.configure([
      { id: "build", command: "echo built", needs: [], env: PUSH_ENV },
    ]);
    await until(() => last(l).nodes.build?.status === "ok");

    expect(pusher.calls).toHaveLength(1);
    expect(last(l).nodes.build?.push).toBeUndefined();
    expect(await l.logOf("build", "push")).toBe("");
  });

  it("does not push a recipe that FAILED", async () => {
    const pusher = stubPusher(async () => ({ stored: 1, present: 0, bytes: 1 }));
    const l = await lane(pusher);
    await l.configure([
      { id: "build", command: "exit 3", needs: [], env: PUSH_ENV },
    ]);
    await until(() => last(l).nodes.build?.status === "failed");
    expect(pusher.calls).toEqual([]);
    expect(last(l).nodes.build?.exitCode).toBe(3);
    expect(last(l).nodes.build?.push).toBeUndefined();
  });

  it("never reaches the pusher for a lane with no push configuration", async () => {
    const pusher = stubPusher(async () => ({ stored: 1, present: 0, bytes: 1 }));
    const l = await lane(pusher);
    await l.configure([{ id: "build", command: "echo built", needs: [] }]);
    await until(() => last(l).nodes.build?.status === "ok");
    expect(pusher.calls).toEqual([]);
    expect(last(l).nodes.build?.push).toBeUndefined();
  });

  it("delivers a task's environment to the recipe — and NOT the run's token", async () => {
    const pusher = stubPusher(async () => null);
    const l = await lane(pusher);
    await l.configure([
      {
        id: "build",
        command: "echo index=$ODU_SHARD_INDEX token=[${ODU_CACHE_TOKEN:-absent}]",
        needs: [],
        env: { ...PUSH_ENV, ODU_SHARD_INDEX: "2" },
      },
    ]);
    await until(() => last(l).nodes.build?.status === "ok");
    const log = await l.logOf("build");
    expect(log).toContain("index=2");
    expect(log).toContain("token=[absent]");
    expect(log).not.toContain(PUSH_ENV.ODU_CACHE_TOKEN);
    expect(pusher.calls[0]?.token).toBe(PUSH_ENV.ODU_CACHE_TOKEN);
  });
});
