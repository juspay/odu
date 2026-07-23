/**
 * End-to-end over the MCP agent face: drive the nix-built `odu mcp` stdio server
 * with a real MCP client and assert the `wait_for_settle` contract from
 * juspay/odu#49 — the exact tool the field trap was hit through.
 *
 * Black-box like the rest of tests/e2e: no import from `src/`. The regressions
 * this pins are the ones the in-process unit suite (src/mcp/server.test.ts)
 * proves against an injected surface — here they run against the REAL binary,
 * the real coordinator, and a real `allocateSeq`, so the coordinator's seq
 * stamp is verified end to end (a unit test can only inject the seq).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, it } from "vitest";
import { buildOduBinary, cleanup, hermeticEnv, makeFixture } from "./harness";

let oduBin: string;

beforeAll(() => {
  oduBin = buildOduBinary();
}, 600_000);

/** Connect a real MCP client to `odu mcp` spawned in `dir`. The stdio transport
 *  owns the child; `close()` (returned) tears both down. */
async function connectMcp(dir: string): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const transport = new StdioClientTransport({
    command: oduBin,
    args: ["mcp"],
    cwd: dir,
    env: hermeticEnv as Record<string, string>,
  });
  const client = new Client({ name: "odu-e2e", version: "0.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

/** The JSON text of a successful tool result's first content block. */
function resultText(res: unknown): string {
  const content = (res as { content?: { text?: string }[] }).content ?? [];
  return content[0]?.text ?? "";
}

/** Whether the `run` tool actually brought a coordinator up. `run` returns a
 *  SUCCESS tool result even when the spawn refused (`started:false` + `error`),
 *  so a bare `isError` check would miss a run that never started. */
function runStarted(res: unknown): boolean {
  return (JSON.parse(resultText(res)) as { started?: boolean }).started === true;
}

describe("odu mcp — wait_for_settle (black-box, juspay/odu#49)", () => {
  it("ask 1: no live run fails LOUD, not an instant empty verdict", async () => {
    const dir = makeFixture("pass");
    const { client, close } = await connectMcp(dir);
    try {
      // The issue's exact reproduction: wait_for_settle in a checkout with no
      // live run. Pre-fix this returned {settled:false, …} in ~2ms; now the tool
      // fails LOUD with the CLI's `odu status` message. surface-mcp surfaces a
      // handler throw as a tools/call result with isError:true (not a JSON-RPC
      // reject) — the loud text is the contract, not the transport shape.
      const res = await client.callTool({
        name: "wait_for_settle",
        arguments: { timeout_ms: 5000 },
      });
      expect(res.isError).toBe(true);
      expect(resultText(res)).toMatch(/no run in progress in this checkout/);
    } finally {
      await close();
      cleanup(dir);
    }
  }, 120_000);

  it("ask 2: a real run's settled verdict carries its identity (sha7#seq)", async () => {
    const dir = makeFixture("pass");
    const { client, close } = await connectMcp(dir);
    try {
      // `linger` keeps the coordinator alive after the (fast) fixture settles,
      // so `wait_for_settle` can read the settled verdict rather than racing the
      // coordinator's exit. `no_strict` skips the GitHub-origin post the
      // throwaway fixture has no remote for (as the CLI e2e harness does).
      const run = await client.callTool({
        name: "run",
        arguments: { linger: true, no_strict: true },
      });
      expect(runStarted(run)).toBe(true);

      const res = await client.callTool({
        name: "wait_for_settle",
        arguments: { timeout_ms: 120_000, fail_fast: false },
      });
      expect(res.isError).toBeFalsy();
      const verdict = JSON.parse(resultText(res)) as {
        settled: boolean;
        passed: boolean;
        sha7: string;
        seq: number | null;
      };
      expect(verdict.settled).toBe(true);
      expect(verdict.passed).toBe(true);
      // The coordinator stamped a real sha7 (7 hex from HEAD) and a real seq
      // (allocateSeq, 1-based) onto the fan-in surface — proof the identity is
      // carried by the live run, not injected.
      expect(verdict.sha7).toMatch(/^[0-9a-f]{7}$/);
      expect(verdict.seq).toBeGreaterThanOrEqual(1);
    } finally {
      await close();
      cleanup(dir);
    }
  }, 180_000);

  it("ask 3: expected_sha mismatch on a live run fails LOUD", async () => {
    const dir = makeFixture("pass");
    const { client, close } = await connectMcp(dir);
    try {
      const run = await client.callTool({
        name: "run",
        arguments: { linger: true, no_strict: true },
      });
      expect(runStarted(run)).toBe(true);

      const res = await client.callTool({
        name: "wait_for_settle",
        arguments: {
          timeout_ms: 10_000,
          fail_fast: false,
          expected_sha: "0000000",
        },
      });
      expect(res.isError).toBe(true);
      expect(resultText(res)).toMatch(/no live run matching 0000000/);

      // Clean up the lingering coordinator so the fixture teardown is quiet.
      await client.callTool({ name: "cancel", arguments: {} });
    } finally {
      await close();
      cleanup(dir);
    }
  }, 180_000);
});
