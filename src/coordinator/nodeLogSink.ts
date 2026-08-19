/**
 * The coordinator's durable projection of the shared log tail: every mutation
 * of a node's in-memory tail also lands in `.ci/<sha7>/<platform>/<node>.log`
 * (justci's layout). The tail is the shared primitive — the runner serves it
 * raw — and durability is the coordinator's addition on top of it.
 *
 * A module rather than a cluster of closures inside `orchestrate` because it
 * encapsulates ONE axis of change with a name: **how a node's output is made
 * durable, and which run owns the file.** Per-commit addressing vs per-run,
 * truncate vs rotate vs a seam marker, `appendFileSync` vs a buffered writer —
 * every one of those edits lands here and nowhere else, and the file address
 * (`logPathFor`) now sits next to the ownership rule that changes with it. The
 * run keeps the policy that is genuinely its own: which frame routes where, and
 * when a node's log has had the run's last word.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createLogTail, type CreateLogTailResult } from "../common/logTail";
import { logPathFor } from "./statuses";

export interface NodeLogSink {
  /** Append to the tail and to the durable file. */
  append: (id: string, text: string) => void;
  /** Replace the tail's buffer and the file's contents (a rerun's snapshot). */
  reset: (id: string, text: string) => void;
  /** This node's log is complete — publish the terminal, having claimed the
   *  file, so a node whose only news is that it finished still owns its path. */
  end: (id: string) => void;
  /** Claim a node's file for this run without writing anything. */
  claim: (id: string) => void;
  /** Would `reset(id, text)` change anything a reader can observe? */
  isNoopReset: CreateLogTailResult["isNoopReset"];
  /** The `nodeLog` source this coordinator serves on `.ci/odu.sock`, and the
   *  live view's `openLog` seam. */
  streamSource: CreateLogTailResult["streamSource"];
}

export function createNodeLogSink(repoRoot: string, sha7: string): NodeLogSink {
  const tail = createLogTail();
  const fileFor = (id: string): string => join(repoRoot, logPathFor(sha7, id));
  /** The log directories this process has already created. A run's node set is
   *  fixed, so this is bounded by the lane count — and since juspay/odu#84 the
   *  provisioning narration flows through `append` one line at a time
   *  (thousands of `copying path` lines), on the same event loop that serves
   *  `.ci/odu.sock`. An `mkdirSync` per line is a sync syscall burst degrading
   *  the very window the socket was moved ahead of the claim to make watchable.
   *  `appendFileSync` stays: a durable log that survives a SIGKILL is the point. */
  const madeDirs = new Set<string>();
  /** Node log files this run has already opened. The first write of a run
   *  TRUNCATES: `.ci/<sha7>/<plat>/<node>.log` is addressed by commit, not by
   *  run, so without this a second run of the same SHA appends its output onto
   *  the first run's with nothing marking the seam — a file that reads like one
   *  recipe emitting everything twice (juspay/odu#87). A node rerun *within* a
   *  run already resets the file through the snapshot frame; truncating here
   *  makes a whole re-run behave the same way. Bounded by the run's node set,
   *  like `madeDirs`. */
  const openedFiles = new Set<string>();

  /** Resolve a node's durable path and CLAIM it for this run: the first touch
   *  truncates. Named for the claim rather than for the path resolution because
   *  the claim is the policy — "which run owns this file" — and the path is
   *  just how it is addressed. Returns the path so writers can chain. */
  const claimLog = (id: string): string => {
    const file = fileFor(id);
    const dir = dirname(file);
    if (!madeDirs.has(dir)) {
      mkdirSync(dir, { recursive: true });
      madeDirs.add(dir);
    }
    if (!openedFiles.has(file)) {
      openedFiles.add(file);
      writeFileSync(file, "");
    }
    return file;
  };

  return {
    append: (id, text) => {
      tail.append(id, text);
      appendFileSync(claimLog(id), text);
    },
    reset: (id, text) => {
      tail.reset(id, text);
      writeFileSync(claimLog(id), text);
    },
    // Composed like the other two rather than open-coded at its call sites: a
    // caller ending a fan-in log must not have to rediscover that the file is
    // claimed first, and since every coordinator-owned outcome ends a log there
    // are several of them.
    end: (id) => {
      claimLog(id);
      tail.end(id);
    },
    claim: (id) => {
      claimLog(id);
    },
    isNoopReset: tail.isNoopReset,
    streamSource: tail.streamSource,
  };
}
