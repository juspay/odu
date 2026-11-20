import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { dialRun } from "@odu/run-client/dial";
import { runUnary, subscribe } from "../common/effectEdge";
import { waitFor } from "../common/scaffoldForTest";
import { agentReaderForSocket } from "./agentReader";
import { waitForSettle } from "./waitForSettle";
import type { ClaimOutcome } from "./runEnv";
import { runCommand } from "./run";

const hasJust =
  spawnSync("just", ["--version"], { encoding: "utf-8" }).status === 0;

const PLATFORM = process.platform === "darwin" ? "aarch64-darwin" : "x86_64-linux";

interface Fixture {
  dir: string;
  restore: () => void;
}

const open: Fixture[] = [];
afterEach(() => {
  for (const f of open.splice(0)) {
    f.restore();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-claim-"));
  const git = (...args: string[]): void => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  writeFileSync(
    join(dir, "justfile"),
    ['[metadata("ci")]', "default: unit", "", "unit:", "    true", ""].join("\n"),
  );
  writeFileSync(
    join(dir, "hosts.json"),
    JSON.stringify({ [PLATFORM]: "unreachable.invalid" }),
  );
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  git("remote", "add", "origin", "file:///nonexistent/origin.git");

  const prevCwd = process.cwd();
  const prevHosts = process.env.ODU_HOSTS;
  const prevSource = process.env.SURFACE_AGENT_FLAKE_REF;
  process.chdir(dir);
  process.env.ODU_HOSTS = join(dir, "hosts.json");
  process.env.SURFACE_AGENT_FLAKE_REF = "path:/nonexistent";
  open.push({
    dir,
    restore: () => {
      process.chdir(prevCwd);
      if (prevHosts === undefined) delete process.env.ODU_HOSTS;
      else process.env.ODU_HOSTS = prevHosts;
      if (prevSource === undefined) delete process.env.SURFACE_AGENT_FLAKE_REF;
      else process.env.SURFACE_AGENT_FLAKE_REF = prevSource;
    },
  });
  return dir;
}

function sha7Of(dir: string): string {
  return spawnSync("git", ["rev-parse", "--short=7", "HEAD"], {
    cwd: dir,
    encoding: "utf-8",
  }).stdout.trim();
}

async function dialUntilServing(
  socketPath: string,
  timeoutMs = 20_000,
): Promise<NonNullable<Awaited<ReturnType<typeof dialRun>>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const dialed = await dialRun(socketPath);
    if (dialed !== null) return dialed;
    if (Date.now() > deadline) throw new Error("the coordinator never served");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.if(hasJust)("a cancel that lands mid-claim", () => {
  it("finalizes an early whole-run cancel without an initialization crash", async () => {
    const dir = fixture();
    const socketPath = join(dir, ".ci", "odu.sock");
    const runModule = join(import.meta.dir, "run.ts");
    const childDir = mkdtempSync(join(tmpdir(), "odu-early-cancel-"));
    const childFile = join(childDir, "early-cancel.ts");
    writeFileSync(
      childFile,
      [
        `import { runCommand } from ${JSON.stringify(runModule)};`,
        "void runCommand({",
        "  selectors: [], platforms: [], hostPins: [], noDeps: false,",
        "  noStrict: true, noSnapshot: false, noPost: true,",
        "  supersede: false, linger: false, noWait: false,",
        "}, { claimVenues: () => new Promise(() => {}) }).catch((err) => {",
        "  console.error(err);",
        "  process.exit(1);",
        "});",
        "",
      ].join("\n"),
    );

    const child = spawn(process.execPath, [childFile], {
      cwd: dir,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exited = new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? -1));
      child.on("error", () => resolve(-1));
    });

    const dialed = await Promise.race([
      dialUntilServing(socketPath),
      exited.then((code) => {
        throw new Error(
          `early-cancel helper exited ${code} before serving:\n${stderr}`,
        );
      }),
    ]);
    try {
      const ack = await runUnary(dialed.client.surface.run.cancel({}));
      expect(ack.ok).toBe(true);
      const code = await Promise.race([
        exited,
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), 10_000),
        ),
      ]);
      expect(code).toBe(130);
      expect(stderr).not.toContain("ReferenceError");
      expect(stderr).not.toContain("before initialization");
      const timings = readFileSync(
        join(dir, ".ci", sha7Of(dir), "timings.jsonl"),
        "utf-8",
      );
      expect(timings).toContain(`unit@${PLATFORM}`);
    } finally {
      child.kill("SIGKILL");
      await dialed.close().catch(() => {});
      rmSync(childDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("does not let wait_for_settle call the run over while the claim holds a box", async () => {
    const dir = fixture();
    const socketPath = join(dir, ".ci", "odu.sock");

    let releaseClaim: (outcome: ClaimOutcome) => void = () => {};
    const claimHeld = new Promise<ClaimOutcome>((resolve) => {
      releaseClaim = resolve;
    });
    let claimEntered = false;

    const run = runCommand(
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
      },
      {
        claimVenues: async () => {
          claimEntered = true;
          return claimHeld;
        },
      },
    );
    const runOutcome = run.catch((err: unknown) => err);

    await Promise.race([
      waitFor(() => claimEntered, 20_000),
      runOutcome.then(result => { throw new Error(`run ended before claim: ${String(result)}`); }),
    ]);
    const dialed = await dialUntilServing(socketPath);

    try {
      const ack = await runUnary(
        dialed.client.surface.lane.cancel({ platform: PLATFORM }),
      );
      expect(ack.ok).toBe(true);

      const verdict = await waitForSettle({
        client: agentReaderForSocket(socketPath),
        timeoutMs: 750,
        failFast: false,
        socketPath,
      });
      expect(verdict.settled).toBe(false);
      expect(verdict.timed_out).toBe(true);
    } finally {
      releaseClaim({
        ok: false,
        error: new Error("odu: test released the claim"),
      });
      await dialed.close();
      let backstop: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        runOutcome,
        new Promise((r) => {
          backstop = setTimeout(r, 10_000);
        }),
      ]);
      if (backstop !== undefined) clearTimeout(backstop);
    }
  }, 60_000);
});

describe.if(hasJust)("a node the coordinator itself terminalizes", () => {
  it("ends its fan-in log and owns its file, so `logs -f` returns and no stale bytes survive", async () => {
    const dir = fixture();
    const socketPath = join(dir, ".ci", "odu.sock");
    const git = (...args: string[]): void => {
      const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    };
    writeFileSync(join(dir, ".gitignore"), ".ci/\n");
    git("add", "-A");
    git("commit", "-qm", "ignore .ci");
    const sha7 = spawnSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: dir,
      encoding: "utf-8",
    }).stdout.trim();
    const logFile = join(dir, ".ci", sha7, PLATFORM, "unit.log");
    mkdirSync(join(dir, ".ci", sha7, PLATFORM), { recursive: true });
    writeFileSync(logFile, "STALE OUTPUT FROM THE PREVIOUS RUN\n");

    let releaseClaim: (outcome: ClaimOutcome) => void = () => {};
    const claimHeld = new Promise<ClaimOutcome>((resolve) => {
      releaseClaim = resolve;
    });
    let claimEntered = false;
    const run = runCommand(
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
      },
      {
        claimVenues: async () => {
          claimEntered = true;
          return claimHeld;
        },
      },
    );
    const runOutcome = run.catch((err: unknown) => err);

    await Promise.race([
      waitFor(() => claimEntered, 20_000),
      runOutcome.then(result => { throw new Error(`run ended before claim: ${String(result)}`); }),
    ]);
    const dialed = await dialUntilServing(socketPath);
    try {
      const kinds: string[] = [];
      const sub = subscribe(
        dialed.client.surface.nodeLog.get({ id: `unit@${PLATFORM}` }),
      );
      void (async () => {
        try {
          for await (const frame of sub) {
            kinds.push(frame.kind);
            if (frame.kind === "end") break;
          }
        } catch {
        }
      })();
      await waitFor(() => kinds.length > 0, 20_000);

      releaseClaim({
        ok: false,
        error: new Error("odu: test released the claim"),
      });

      await waitFor(() => kinds.includes("end"), 20_000);
      void sub.return?.();
      await runOutcome;

      expect(readFileSync(logFile, "utf-8")).not.toContain("STALE OUTPUT");
    } finally {
      await dialed.close();
      let backstop: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        runOutcome,
        new Promise((r) => {
          backstop = setTimeout(r, 10_000);
        }),
      ]);
      if (backstop !== undefined) clearTimeout(backstop);
    }
  }, 60_000);
});

it.if(hasJust)("refuses in-place mode for a remote pool even on a clean tree", async () => {
  fixture();
  let claimed = false;
  await expect(runCommand({
    selectors: [], platforms: [], hostPins: [], noDeps: false,
    noStrict: true, noSnapshot: true, noPost: true,
    supersede: false, linger: false, noWait: false,
  }, { claimVenues: async () => { claimed = true; return { ok: false, error: new Error("unexpected claim") }; } })).rejects.toThrow("only applies to localhost lanes");
  expect(claimed).toBe(false);
});

it.if(hasJust)("explains forced snapshot transport without origin before claiming", async () => {
  const dir = fixture();
  spawnSync("git", ["remote", "remove", "origin"], { cwd: dir });
  writeFileSync(join(dir, "hosts.json"), JSON.stringify({ [PLATFORM]: "localhost" }));
  const prior = process.env.ODU_SNAPSHOT_TRANSPORT;
  process.env.ODU_SNAPSHOT_TRANSPORT = "always";
  let claimed = false;
  try {
    await expect(runCommand({
      selectors: [], platforms: [], hostPins: [], noDeps: false,
      noStrict: true, noSnapshot: false, noPost: true,
      supersede: false, linger: false, noWait: false,
    }, { claimVenues: async () => { claimed = true; return { ok: false, error: new Error("unexpected claim") }; } })).rejects.toThrow("no origin remote");
    expect(claimed).toBe(false);
  } finally {
    if (prior === undefined) delete process.env.ODU_SNAPSHOT_TRANSPORT;
    else process.env.ODU_SNAPSHOT_TRANSPORT = prior;
  }
});
