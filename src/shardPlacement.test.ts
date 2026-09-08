/** Drive the real coordinator and all public history projections with distinct workers. */
import { afterEach, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "@odu/execution/coordinator/run";
import type { LaneOptions } from "@odu/execution/coordinator/lane";
import type { LeaseHandle } from "@odu/execution/coordinator/lease";
import { pendingNode, type PipelineState } from "@odu/run-client/surface";
import {
  handleFor,
  readAttemptRecord,
  readJournal,
} from "@odu/run-history/store";
import { readAttention } from "@odu/run-history/query";
import { projectRun } from "@odu/service/registry";
import { answerOf } from "@odu/service/wait";

const platform =
  process.platform === "darwin" ? "aarch64-darwin" : "x86_64-linux";
const remoteHosts = [
  "primary.invalid",
  "burst-two.invalid",
  "burst-three.invalid",
];
const originalCwd = process.cwd();
const restores: (() => void)[] = [];
afterEach(() => {
  process.chdir(originalCwd);
  for (const restore of restores.splice(0)) restore();
});

for (const scenario of [
  { outcome: "failed", remote: true },
  { outcome: "ok", remote: true },
  { outcome: "ok", remote: false },
] as const) {
  const { outcome, remote } = scenario;
  const hosts = remote ? remoteHosts : ["localhost"];
  it(`records each shard's host on ${outcome} (${remote ? "remote" : "local without bundling"}), including log-first attempts and released bursts`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "odu-placement-"));
    const catalog = join(dir, "catalog");
    const env = {
      ODU_HOSTS: join(dir, "hosts.json"),
      ODU_STATE_DIR: catalog,
      ODU_SNAPSHOT_MAX_BYTES: remote ? "67108864" : "1",
      ODU_RUNNER_FLAKE: "git+file:///nonexistent",
      ODU_AGENT_SUBSTITUTERS: "https://cache.invalid",
      ODU_AGENT_TRUSTED_PUBLIC_KEYS: "cache.invalid:0000000000",
    };
    const prior = Object.fromEntries(
      Object.keys(env).map((k) => [k, process.env[k]]),
    );
    restores.push(() => {
      for (const [k, v] of Object.entries(prior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
    });
    writeFileSync(
      join(dir, "hosts.json"),
      JSON.stringify({ [platform]: hosts }),
    );
    writeFileSync(join(dir, ".gitignore"), ".ci/\ncatalog/\n");
    writeFileSync(
      join(dir, "justfile"),
      '[metadata("ci")]\ndefault: check\n\nprepare:\n    true\n\n[metadata("odu:shard=3")]\ncheck: prepare\n    true\n',
    );
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("add", "-A");
    git(
      "-c",
      "user.name=test",
      "-c",
      "user.email=t@localhost",
      "commit",
      "-qm",
      "fixture",
    );
    if (remote) git("remote", "add", "origin", "file:///unused.git");
    process.chdir(dir);
    Object.assign(process.env, env);
    const released = new Set<string>();
    const lease = (host: string): LeaseHandle => ({
      host,
      lost: new Promise(() => {}),
      release: () => {
        released.add(host);
      },
    });
    const runId = !remote
      ? "placement-local"
      : outcome === "ok"
        ? "placement-green"
        : "placement-redd";
    const started: string[] = [];
    const code = await runCommand(
      {
        selectors: [],
        platforms: [],
        hostPins: [],
        noDeps: false,
        noStrict: true,
        noSnapshot: false,
        noPost: true,
        supersede: false,
        linger: false,
        noWait: false,
        runId,
      },
      {
        claimVenues: async () => ({
          ok: true,
          lanes: { [platform]: hosts[0]! },
          leases: [lease(hosts[0]!)],
        }),
        leaseBurstSlots: async () => hosts.slice(1).map(lease),
        startLane: (opts: LaneOptions) => {
          started.push(opts.host);
          if (!remote) {
            expect(opts.snapshot?.bundlePath).toBeNull();
            expect(opts.snapshot?.bytes).toBe(0);
          }
          const state: Omit<PipelineState, "order" | "nodes"> & {
            order: string[];
            nodes: Record<string, PipelineState["nodes"][string]>;
          } = {
            name: "ci",
            sha7: "",
            dirty: false,
            order: [],
            nodes: {},
          };
          const runTasks = (ids: string[]) => {
            for (const id of ids) {
              state.order.push(id);
              state.nodes[id] = pendingNode({
                id,
                name: id,
                command: "true",
                needs: [],
              });
            }
            setImmediate(() => {
              // This opens the durable attempts before their first status frame.
              for (const id of ids)
                opts.onLogFrame(id, {
                  kind: "snapshot",
                  text: `on ${opts.host}\n`,
                });
              for (const id of ids)
                state.nodes[id] = { ...state.nodes[id]!, status: "running" };
              opts.onNodes(structuredClone(state));
              for (const id of ids)
                state.nodes[id] = {
                  ...state.nodes[id]!,
                  status: id === "check" ? outcome : "ok",
                  exitCode: id === "check" && outcome === "failed" ? 1 : 0,
                };
              // Verdicts arrive before log ends and are published later by the gate.
              opts.onNodes(structuredClone(state));
              for (const id of ids) opts.onLogFrame(id, { kind: "end" });
            });
          };
          runTasks(["_ci-setup", ...opts.tasks.map((t) => t.id)]);
          return {
            platform,
            extend: async (tasks) => {
              runTasks(tasks.map((t) => t.id));
              return true;
            },
            rerun: async () => true,
            cancel: async () => true,
            drain: async () => ({ reason: "complete" }),
            close: () => {},
          };
        },
      },
    );
    expect(code).toBe(outcome === "ok" ? 0 : 1);
    expect(started).toEqual(hosts);
    expect([...released].sort()).toEqual([...hosts].sort());
    const projected = projectRun(runId, { root: join(catalog, "runs") });
    expect(projected).not.toBeNull();
    const handle = handleFor(runId, { root: join(catalog, "runs") });
    const answer = answerOf(readAttention(handle, {}));
    const journal = readJournal(handle).entries.map((entry) => entry.event);
    for (let index = 0; index < hosts.length; index++) {
      const ids =
        index === 0
          ? [
              `${hosts.length === 1 ? "check" : "check[1-of-3]"}@${platform}`,
              `prepare@${platform}`,
              `_ci-setup@${platform}`,
            ]
          : [
              `check[${index + 1}-of-3]@${platform}`,
              `check[${index + 1}-of-3]::prepare@${platform}`,
              `check[${index + 1}-of-3]::_ci-setup@${platform}`,
            ];
      for (const id of ids) {
        const statuses = journal.filter(
          (e) => e.kind === "node_status" && e.node === id,
        );
        expect(statuses.length, id).toBeGreaterThan(0);
        for (const event of statuses) {
          if (
            event.kind === "node_status" &&
            (event.status === "ok" || event.status === "failed")
          )
            expect(event.placement.host, id).toBe(hosts[index]!);
        }
        for (const event of journal.filter(
          (e) => e.kind === "attempt_started" && e.node === id,
        )) {
          // Primary setup can start while claiming, before a host is known.
          if (
            event.kind === "attempt_started" &&
            id !== `_ci-setup@${platform}`
          )
            expect(event.placement.host, id).toBe(hosts[index]!);
        }
        expect(readAttemptRecord(handle, id, 1)?.placement.host, id).toBe(
          hosts[index]!,
        );
        expect(projected!.nodes.find((n) => n.id === id)?.host, id).toBe(
          hosts[index]!,
        );
      }
      if (outcome === "failed")
        expect(answer.failures.find((f) => f.node === ids[0])?.host).toBe(
          hosts[index]!,
        );
    }
    expect(
      readAttemptRecord(handle, `check@${platform}`, 1)?.placement.host,
    ).toBe(hosts[0]!);
    // Aggregate coordination belongs to the primary, even after its lease releases.
    expect(
      projected!.nodes.find((n) => n.id === `check@${platform}`)?.host,
    ).toBe(hosts[0]!);
  }, 30_000);
}
