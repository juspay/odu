import { describe, expect, it } from "bun:test";
import { EMPTY_STATE } from "@odu/run-client/surface";
import type { TaskSpec } from "../common/spec";
import { installShardTopology, tasksForShard } from "./shards";

const PLATFORM = "x86_64-linux";
const ROOT = "ci::e2e";

const task: TaskSpec = {
  id: ROOT,
  command: "just --no-deps ci::e2e",
  needs: [],
  shards: 4,
};

describe("a sharded recipe's environment", () => {
  it("rides TaskSpec.env, which is what reaches spawn", () => {
    const [sharded] = tasksForShard([task], ROOT, 2, 4);
    expect(sharded?.env).toEqual({ ODU_SHARD_INDEX: "2", ODU_SHARD_TOTAL: "4" });
    const [withPush] = tasksForShard(
      [{ ...task, env: { ODU_CACHE_TOKEN: "odu_secret" } }],
      ROOT,
      1,
      3,
    );
    expect(withPush?.env).toMatchObject({
      ODU_CACHE_TOKEN: "odu_secret",
      ODU_SHARD_INDEX: "1",
    });
  });

  it("is ABSENT from every public node's command", () => {
    const state = installShardTopology(
      { ...EMPTY_STATE, order: [], nodes: {} },
      PLATFORM,
      { rootId: ROOT, total: 4, tasks: [task] },
    );
    const commands = Object.values(state.nodes).map((node) => node.command);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).not.toMatch(/(^|\s)[A-Z_]+=/);
      expect(command).not.toContain("ODU_SHARD_INDEX");
      expect(command).not.toContain("ODU_CACHE_TOKEN");
    }
    expect(commands).toContain(task.command);
    expect(Object.values(state.nodes).map((node) => node.name)).toContain(
      "ci::e2e[3-of-4]",
    );
  });
});
