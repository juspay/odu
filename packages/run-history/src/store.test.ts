/**
 * The durable store — what survives the coordinator that wrote it.
 *
 * The properties pinned here are the ones a reader has to be able to trust
 * months later, from a different build than the one that did the writing:
 *
 *   - REGISTER BEFORE EXECUTE: a manifest and an ownership epoch exist before
 *     anything observable happens, so "the coordinator crashed" is a state a
 *     face can describe rather than a directory nobody can name.
 *   - DENSE SEQUENCE: journal `seq` starts at 1 and never gaps, because a
 *     cursor IS a seq — a hole is indistinguishable from a delivery a caller
 *     missed.
 *   - FORGIVING READS: a torn tail or a record from a newer writer is COUNTED
 *     and skipped, never thrown. A history reader that crashes on history is
 *     worse than one that says "and 2 events I could not read".
 *   - IMMUTABLE EVIDENCE: an attempt's bytes are written once. A retry
 *     allocates the next ordinal and never names the old one again.
 *   - EVERY WRITE IS FENCED: a superseded writer's next append returns null and
 *     puts nothing on disk, rather than racing a successor for a file tail.
 *
 * Easy to get wrong, and so tested from the failure side: the fenced append and
 * the unreadable line get as much weight as the happy path. Every test passes
 * an explicit catalog `root` — a suite that wrote into the developer's real
 * `~/.local/state/odu` is a suite nobody can run twice.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { encodeNodeKey } from "./ids";
import { claimOwnership, OWNERSHIP_GRACE_MS } from "./owner";
import {
  ATTEMPT_FILES,
  attemptDir,
  RUN_EVIDENCE,
  RUN_FILES,
} from "./paths";
import { RUN_RECORD_FORMAT, type RunManifest } from "./schema";
import {
  appendAttemptLog,
  appendEvent,
  attemptsFor,
  expireRun,
  latestRun,
  listRuns,
  nodesWithEvidence,
  readAttemptLog,
  readAttemptRecord,
  readExpiry,
  readJournal,
  readManifest,
  readVerdict,
  registerRun,
  resolveRunIdPrefix,
  resolveRunRef,
  type RunHandle,
  sealAttempt,
  startAttempt,
  writeVerdict,
} from "./store";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

/** A catalog root of our own. Never the real one. */
function tmpCatalog(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-store-"));
  dirs.push(dir);
  return dir;
}

const T0 = 1_700_000_000_000;
const SHA = "26d2c2dabcdef0123456789012345678901234ab";
const NODE = "ci::e2e@x86_64-linux";

/** The half of a manifest a caller supplies — the store stamps `version` and
 *  `owner` itself, which is why `registerRun` takes exactly this shape. */
type ManifestInput = Omit<RunManifest, "version" | "registeredBy">;

function manifest(over: Partial<ManifestInput> = {}): ManifestInput {
  return {
    runId: "0000000a-0001",
    repo: "juspay/odu",
    sha: SHA,
    seq: 1,
    pipeline: "ci",
    repoRoot: "/checkouts/odu",
    createdAt: T0,
    scope: { selectors: ["e2e"], platforms: [], noDeps: false },
    snapshot: {
      mode: "strict",
      expectedSha: SHA,
      dirty: false,
      retryable: true,
    },
    build: { oduVersion: "0.1.0", self: null, runnerFlake: null },
    parentRunId: null,
    requestId: null,
    ...over,
  };
}

/** Register, or fail the test loudly — most tests need a run to exist, not to
 *  re-litigate that registration works. */
function register(root: string, over: Partial<ManifestInput> = {}) {
  const result = registerRun(manifest(over), {
    root,
    endpoint: "/run/odu.sock",
    now: T0,
  });
  if (!result.ok) throw new Error(`registration refused: ${result.refusal.reason}`);
  return result;
}

/** Take the run over from a machine that is not this one — the honest way to
 *  fence a writer in a test, since the incumbent's pid is OUR pid and is very
 *  much alive. A stale heartbeat plus a different host is the documented
 *  cross-host takeover. */
function fence(handle: RunHandle): void {
  const takeover = claimOwnership({
    runId: handle.runId,
    dir: handle.dir,
    endpoint: null,
    now: T0 + OWNERSHIP_GRACE_MS + 1,
    pid: 5555,
    host: "some-other-box.invalid",
    isAlive: () => true,
  });
  if (!takeover.ok) throw new Error(`takeover refused: ${takeover.refusal.reason}`);
}

describe("registerRun", () => {
  it("publishes a manifest, claims the epoch, and writes `registered` as seq 1", () => {
    const root = tmpCatalog();
    const input = manifest();
    const result = register(root);

    expect(result.token.epoch).toBe(1);
    expect(result.manifest.version).toBe(RUN_RECORD_FORMAT);
    expect(result.manifest.registeredBy.epoch).toBe(1);
    expect(result.manifest.registeredBy.endpoint).toBe("/run/odu.sock");
    expect(result.manifest.registeredBy.claimedAt).toBe(T0);

    // Round-trip: what a later, differently-built reader gets back is what was
    // written — including the mutable owner half.
    expect(readManifest(result.handle)).toEqual(result.manifest);

    const journal = readJournal(result.handle);
    expect(journal.unreadable).toBe(0);
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]?.seq).toBe(1);
    expect(journal.entries[0]?.at).toBe(T0);
    // The scope travels on the first line, so a reader knows what a later
    // verdict actually covers without opening the manifest.
    expect(journal.entries[0]?.event).toEqual({
      kind: "registered",
      scope: input.scope,
    });
  });

  it("refuses a run directory a LIVE owner already holds", () => {
    const root = tmpCatalog();
    const first = register(root);

    const second = registerRun(manifest(), {
      root,
      endpoint: "/run/odu-2.sock",
      now: T0 + 1_000, // well inside the grace: the incumbent is alive
    });

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("a live run was registered over");
    expect(second.refusal.kind).toBe("held");
    // And the first owner's manifest is untouched — no half-registration.
    expect(readManifest(first.handle)?.registeredBy.epoch).toBe(1);
  });
});

describe("the journal", () => {
  it("numbers densely from 1 and reads back in seq order", () => {
    const root = tmpCatalog();
    const { handle, token } = register(root);

    const phase = appendEvent(handle, token, { kind: "phase", phase: "lanes" }, T0 + 1);
    const roster = appendEvent(
      handle,
      token,
      { kind: "roster", order: [NODE] },
      T0 + 2,
    );
    const done = appendEvent(
      handle,
      token,
      { kind: "finalized", outcome: "passed" },
      T0 + 3,
    );

    expect(phase?.seq).toBe(2);
    expect(roster?.seq).toBe(3);
    expect(done?.seq).toBe(4);

    const journal = readJournal(handle);
    expect(journal.unreadable).toBe(0);
    expect(journal.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(journal.entries.map((e) => e.event.kind)).toEqual([
      "registered",
      "phase",
      "roster",
      "finalized",
    ]);
  });

  it("returns null from a FENCED append, and writes nothing", () => {
    // The whole point of the fence: a coordinator that has been superseded
    // finds out at its next write. Two writers appending to one journal is the
    // unrecoverable case, so the refusal must cost nothing on disk.
    const root = tmpCatalog();
    const { handle, token } = register(root);
    const before = readJournal(handle).entries;

    fence(handle);

    expect(appendEvent(handle, token, { kind: "phase", phase: "lanes" }, T0 + 9)).toBeNull();
    expect(appendEvent(handle, token, { kind: "finalized", outcome: "failed" }, T0 + 10)).toBeNull();
    expect(readJournal(handle).entries).toEqual(before);
  });

  it("skips a torn tail and a foreign record, and COUNTS them", () => {
    // Two different kinds of unreadable, both of which a real catalog produces:
    // a SIGKILL mid-append leaves a truncated final line, and a newer odu
    // writes an event arm this reader has never heard of. Neither may blind the
    // read — a face that shows history should be able to say "and 2 events I
    // could not read".
    const root = tmpCatalog();
    const { handle, token } = register(root);
    appendEvent(handle, token, { kind: "phase", phase: "lanes" }, T0 + 1);

    const events = join(handle.dir, RUN_FILES.events);
    appendFileSync(events, `${JSON.stringify({ seq: 3, at: T0 + 2, event: { kind: "from_the_future" } })}\n`);
    appendFileSync(events, `{"seq":4,"at":${T0 + 3},"event":{"kind":"pha`); // no newline: torn

    const journal = readJournal(handle);
    expect(journal.unreadable).toBe(2);
    expect(journal.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(journal.entries.map((e) => e.event.kind)).toEqual(["registered", "phase"]);
  });

  it("is empty rather than absent for a run that has no journal file", () => {
    const root = tmpCatalog();
    const { handle } = register(root);
    rmSync(join(handle.dir, RUN_FILES.events));
    expect(readJournal(handle)).toEqual({ entries: [], unreadable: 0, highestSeq: 0 });
  });
});

describe("attempt evidence", () => {
  const placement = { platform: "x86_64-linux", host: "builder-1" };

  it("writes a readable log and seals it with the real byte count, read-only", () => {
    const root = tmpCatalog();
    const { handle, token } = register(root);

    expect(
      startAttempt(handle, token, {
        node: NODE,
        attempt: 1,
        placement,
        startedAt: T0 + 10,
      }),
    ).toBe(true);
    // A multibyte character on purpose: `logBytes` is BYTES, and a length in
    // characters would be a lie a resuming reader would seek by.
    appendAttemptLog(handle, NODE, 1, "compiling…\n");
    appendAttemptLog(handle, NODE, 1, "boom\n");
    const text = "compiling…\nboom\n";

    expect(
      sealAttempt(handle, token, NODE, 1, {
        endedAt: T0 + 20,
        status: "failed",
        exitCode: 1,
        signal: null,
        logComplete: true,
        logTruncationReason: null,
      }),
    ).toBe(true);

    const record = readAttemptRecord(handle, NODE, 1);
    expect(record?.status).toBe("failed");
    expect(record?.exitCode).toBe(1);
    expect(record?.endedAt).toBe(T0 + 20);
    expect(record?.logComplete).toBe(true);
    expect(record?.logBytes).toBe(Buffer.byteLength(text));
    expect(record?.placement).toEqual(placement);

    const slice = readAttemptLog(handle, NODE, 1);
    expect(slice?.text).toBe(text);
    expect(slice?.size).toBe(Buffer.byteLength(text));
    expect(slice?.eof).toBe(true);

    // Sealed evidence is read-only. Not a defence against a determined process
    // — the owner can chmod it back — but it turns "a retry overwrote the log"
    // from a plausible bug into something somebody had to spell out.
    const logPath = join(
      attemptDir(handle.dir, encodeNodeKey(NODE), 1),
      ATTEMPT_FILES.log,
    );
    expect(statSync(logPath).mode & 0o777).toBe(0o444);
  });

  it("leaves a sealed attempt untouched when the node is retried", () => {
    // IMMUTABILITY, which here is really about ADDRESSING: attempt 2 is a new
    // ordinal with its own directory, so nothing about it can reach attempt 1's
    // bytes. A store that reused the ordinal would silently destroy the
    // evidence of the failure that caused the retry.
    const root = tmpCatalog();
    const { handle, token } = register(root);

    startAttempt(handle, token, { node: NODE, attempt: 1, placement, startedAt: T0 + 10 });
    appendAttemptLog(handle, NODE, 1, "first go\n");
    sealAttempt(handle, token, NODE, 1, {
      endedAt: T0 + 20,
      status: "failed",
      exitCode: 2,
      signal: null,
      logComplete: true,
      logTruncationReason: null,
    });

    startAttempt(handle, token, { node: NODE, attempt: 2, placement, startedAt: T0 + 30 });
    appendAttemptLog(handle, NODE, 2, "second go\n");

    expect(readAttemptLog(handle, NODE, 1)?.text).toBe("first go\n");
    expect(readAttemptRecord(handle, NODE, 1)?.exitCode).toBe(2);
    expect(readAttemptLog(handle, NODE, 2)?.text).toBe("second go\n");
    expect(readAttemptRecord(handle, NODE, 2)?.status).toBeNull(); // still running
    expect(attemptsFor(handle, NODE)).toEqual([1, 2]);
  });

  it("refuses to start or seal an attempt once the writer is fenced", () => {
    const root = tmpCatalog();
    const { handle, token } = register(root);
    startAttempt(handle, token, { node: NODE, attempt: 1, placement, startedAt: T0 + 10 });

    fence(handle);

    expect(
      startAttempt(handle, token, { node: NODE, attempt: 2, placement, startedAt: T0 + 40 }),
    ).toBe(false);
    expect(
      sealAttempt(handle, token, NODE, 1, {
        endedAt: T0 + 50,
        status: "ok",
        exitCode: 0,
        signal: null,
        logComplete: true,
        logTruncationReason: null,
      }),
    ).toBe(false);
    // No ordinal was allocated, and attempt 1 is still open rather than sealed
    // by a writer that no longer speaks for the run.
    expect(attemptsFor(handle, NODE)).toEqual([1]);
    expect(readAttemptRecord(handle, NODE, 1)?.status).toBeNull();
  });

  it("names every node it holds evidence for, decoded back to node ids", () => {
    // The directory name is an escaped spelling (`::` and `@` are hostile as
    // path segments); the caller only ever speaks node ids, so the round trip
    // has to survive a real one.
    const root = tmpCatalog();
    const { handle, token } = register(root);
    const other = "ci::unit@aarch64-darwin";

    startAttempt(handle, token, { node: NODE, attempt: 1, placement, startedAt: T0 + 1 });
    startAttempt(handle, token, {
      node: other,
      attempt: 1,
      placement: { platform: "aarch64-darwin", host: null },
      startedAt: T0 + 2,
    });

    expect(nodesWithEvidence(handle)).toEqual([other, NODE].sort());
    expect(nodesWithEvidence(handle)).toContain(NODE);
  });

  it("has no attempts and no evidence for a run that never ran anything", () => {
    const root = tmpCatalog();
    const { handle } = register(root);
    expect(attemptsFor(handle, NODE)).toEqual([]);
    expect(nodesWithEvidence(handle)).toEqual([]);
  });
});

describe("readAttemptLog byte ranges", () => {
  const placement = { platform: "x86_64-linux", host: "builder-1" };

  /** A run whose one attempt log is exactly "0123456789" — ten ASCII bytes, so
   *  every offset in a range assertion is also its character index. */
  function withLog(root: string) {
    const { handle, token } = register(root);
    startAttempt(handle, token, { node: NODE, attempt: 1, placement, startedAt: T0 });
    appendAttemptLog(handle, NODE, 1, "0123456789");
    return handle;
  }

  it("slices from an offset for a limit, and reports eof only at the end", () => {
    const handle = withLog(tmpCatalog());

    const middle = readAttemptLog(handle, NODE, 1, { offset: 2, limit: 3 });
    expect(middle?.text).toBe("234");
    expect(middle?.offset).toBe(2);
    expect(middle?.size).toBe(10);
    expect(middle?.eof).toBe(false); // there are bytes past this slice

    const rest = readAttemptLog(handle, NODE, 1, { offset: 5 });
    expect(rest?.text).toBe("56789");
    expect(rest?.eof).toBe(true);
  });

  it("reads a tail from a NEGATIVE offset, without the caller stat-ing first", () => {
    const handle = withLog(tmpCatalog());

    const tail = readAttemptLog(handle, NODE, 1, { offset: -4 });
    expect(tail?.text).toBe("6789");
    expect(tail?.offset).toBe(6);
    expect(tail?.eof).toBe(true);

    // A tail longer than the file is the whole file, not an error: a face that
    // asks for the last 4 KiB of a 10-byte log wants the 10 bytes.
    const all = readAttemptLog(handle, NODE, 1, { offset: -4096 });
    expect(all?.text).toBe("0123456789");
    expect(all?.offset).toBe(0);
  });

  it("clamps an offset past the end to an empty slice at eof", () => {
    const handle = withLog(tmpCatalog());
    const past = readAttemptLog(handle, NODE, 1, { offset: 50 });
    expect(past?.text).toBe("");
    expect(past?.offset).toBe(10);
    expect(past?.eof).toBe(true);
  });

  it("returns null for an attempt that does not exist", () => {
    // Distinct from an empty log: "there is no such evidence" and "the evidence
    // is empty" are different answers, and a face must not print the second for
    // the first.
    const handle = withLog(tmpCatalog());
    expect(readAttemptLog(handle, NODE, 99)).toBeNull();
    expect(readAttemptLog(handle, "ci::never-ran@x86_64-linux", 1)).toBeNull();
    expect(readAttemptRecord(handle, NODE, 99)).toBeNull();
  });
});

describe("discovery", () => {
  /** Three runs in one catalog: ids sort by start instant, so `c` is newest. */
  function threeRuns(root: string) {
    register(root, { runId: "0000000a-0001", sha: `aaaaaaa${SHA.slice(7)}`, seq: 1 });
    register(root, {
      runId: "0000000b-0001",
      sha: `bbbbbbb${SHA.slice(7)}`,
      seq: 2,
      repoRoot: "/checkouts/other",
    });
    register(root, { runId: "0000000c-0001", sha: `ccccccc${SHA.slice(7)}`, seq: 3 });
  }

  it("lists runs newest first, from the id alone", () => {
    const root = tmpCatalog();
    threeRuns(root);
    expect(listRuns({ root }).map((r) => r.runId)).toEqual([
      "0000000c-0001",
      "0000000b-0001",
      "0000000a-0001",
    ]);
    // The endpoint is projected onto the row so a lister can tell a live run
    // from a finished one without opening it.
    expect(listRuns({ root })[0]?.endpoint).toBe("/run/odu.sock");
    expect(listRuns({ root })[0]?.liveness).toBe("owned");
  });

  it("reports a coordinator that died without finalizing as owner_lost, not running", () => {
    // The listing's own three-state answer, and the reason it cannot be
    // `endpoint !== null`. The manifest's `registeredBy.endpoint` is stamped
    // once at registration and no write path clears it, so a run whose
    // coordinator was killed keeps that address forever — and a lister that
    // trusted it would report the run as executing for the life of the
    // catalog, in the one view an operator scans to find what is still going.
    const root = tmpCatalog();
    const registered = register(root, { runId: "0000000d-0001" });
    // Move ownership to a machine that is not this one and let its heartbeat
    // go stale — the honest way to have a dead owner in a test, since our own
    // pid is very much alive (see `fence`).
    fence(registered.handle);

    const rows = listRuns({ root, now: T0 + OWNERSHIP_GRACE_MS * 4 });
    const row = rows.find((r) => r.runId === "0000000d-0001");
    expect(row?.verdict).toBeNull();
    expect(row?.liveness).toBe("owner_lost");
    // And no address is offered for a socket nobody is serving.
    expect(row?.endpoint).toBeNull();
  });

  it("filters by repoRoot — the catalog is per-user, the checkout is a field", () => {
    const root = tmpCatalog();
    threeRuns(root);
    expect(listRuns({ root, repoRoot: "/checkouts/other" }).map((r) => r.runId)).toEqual([
      "0000000b-0001",
    ]);
    expect(listRuns({ root, repoRoot: "/checkouts/nowhere" })).toEqual([]);
  });

  it("expires every kind of evidence, including the ones added after it was written", () => {
    // The partition, not a list at the call site. `receipts/` and
    // `coordinator.log` were both added to a run directory after `expireRun`
    // named its two deletions inline, and both then survived expiry forever —
    // the coordinator log being the record of a run that died before its
    // per-node logs said anything, which is the case this release exists for.
    const root = tmpCatalog();
    const { handle, token } = register(root, { runId: "0000000e-0001" });
    appendEvent(handle, token, { kind: "roster", order: [NODE] });
    startAttempt(handle, token, {
      node: NODE,
      attempt: 1,
      placement: { platform: "x86_64-linux", host: "builder-1" },
      startedAt: T0,
    });
    writeFileSync(join(handle.dir, RUN_FILES.coordinatorLog), "it died here\n");
    mkdirSync(join(handle.dir, RUN_FILES.receipts), { recursive: true });
    writeFileSync(join(handle.dir, RUN_FILES.receipts, "r1.json"), "{}");
    fence(handle);

    expect(expireRun(handle, T0 + OWNERSHIP_GRACE_MS * 4)).toBe(true);

    for (const gone of RUN_EVIDENCE) {
      expect(existsSync(join(handle.dir, gone)), `${gone} should be gone`).toBe(
        false,
      );
    }
    // And what makes an expired run still answerable stays.
    expect(existsSync(join(handle.dir, RUN_FILES.manifest))).toBe(true);
    expect(readExpiry(handle)).not.toBeNull();
  });

  it("is empty for a catalog that does not exist yet", () => {
    expect(listRuns({ root: join(tmpCatalog(), "never-created") })).toEqual([]);
  });

  it("resolves a run-id prefix to one, none, or an ambiguity", () => {
    // Never a first-match guess: addressing the wrong run is how a retry lands
    // on the wrong commit.
    const root = tmpCatalog();
    threeRuns(root);
    expect(resolveRunIdPrefix("0000000b", { root })).toEqual({
      kind: "one",
      runId: "0000000b-0001",
    });
    expect(resolveRunIdPrefix("zzz", { root })).toEqual({ kind: "none" });
    const many = resolveRunIdPrefix("0000000", { root });
    expect(many.kind).toBe("many");
    if (many.kind !== "many") throw new Error("expected an ambiguity");
    expect(many.matches).toEqual([
      "0000000a-0001",
      "0000000b-0001",
      "0000000c-0001",
    ]);
  });

  it("finds a run by the <sha7>#<seq> ref every face already prints", () => {
    const root = tmpCatalog();
    threeRuns(root);
    expect(resolveRunRef({ sha7: "bbbbbbb", seq: 2 }, { root })).toBe("0000000b-0001");
    // The sha must match as a prefix AND the ordinal must match: a right sha
    // with the wrong ordinal is a different run, not a near miss.
    expect(resolveRunRef({ sha7: "bbbbbbb", seq: 9 }, { root })).toBeNull();
    expect(resolveRunRef({ sha7: "fffffff", seq: 2 }, { root })).toBeNull();
  });

  it("resolves `latest` overall and per checkout", () => {
    const root = tmpCatalog();
    threeRuns(root);
    expect(latestRun({ root })).toBe("0000000c-0001");
    expect(latestRun({ root, repoRoot: "/checkouts/other" })).toBe("0000000b-0001");
    expect(latestRun({ root: tmpCatalog() })).toBeNull();
  });
});

describe("expireRun", () => {
  it("drops the evidence, keeps the answerable record, and leaves a tombstone", () => {
    const root = tmpCatalog();
    const { handle, token } = register(root);
    appendEvent(handle, token, { kind: "phase", phase: "lanes" }, T0 + 1);
    startAttempt(handle, token, {
      node: NODE,
      attempt: 1,
      placement: { platform: "x86_64-linux", host: "builder-1" },
      startedAt: T0 + 2,
    });
    appendAttemptLog(handle, NODE, 1, "bytes that will age out\n");
    sealAttempt(handle, token, NODE, 1, {
      endedAt: T0 + 3,
      status: "failed",
      exitCode: 1,
      signal: null,
      logComplete: true,
      logTruncationReason: null,
    });
    writeVerdict(handle, token, {
      runId: handle.runId,
      outcome: "failed",
      startedAt: T0,
      finishedAt: T0 + 4,
      failed: [NODE],
      errored: [],
      cancelled: [],
      unposted: [],
    });

    expireRun(handle, T0 + 90_000);

    // The bulk is gone…
    expect(existsSync(join(handle.dir, RUN_FILES.events))).toBe(false);
    expect(existsSync(join(handle.dir, RUN_FILES.attempts))).toBe(false);
    expect(readJournal(handle)).toEqual({ entries: [], unreadable: 0, highestSeq: 0 });
    expect(attemptsFor(handle, NODE)).toEqual([]);
    expect(readAttemptLog(handle, NODE, 1)).toBeNull();

    // …and the small, answerable half stays. An agent holding a months-old run
    // id gets "expired, and it failed" rather than "no such run".
    expect(readManifest(handle)?.runId).toBe(handle.runId);
    expect(readVerdict(handle)?.outcome).toBe("failed");
    expect(readExpiry(handle)).toEqual({
      version: RUN_RECORD_FORMAT,
      runId: handle.runId,
      expiredAt: T0 + 90_000,
      outcome: "failed",
    });
    // And the run is still listed — expiry is a tombstone, not a deletion.
    expect(listRuns({ root }).map((r) => r.runId)).toEqual([handle.runId]);
  });

  it("records `unknown` for a run that expired without ever reaching a verdict", () => {
    const root = tmpCatalog();
    const { handle } = register(root);
    expireRun(handle, T0 + 90_000);
    expect(readExpiry(handle)?.outcome).toBe("unknown");
    expect(readVerdict(handle)).toBeNull();
  });
});
