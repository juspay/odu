/**
 * MCP `lease` / `release` tools — agent-held venue layer.
 *
 * `lease` returns immediately with held or waiting (like run → wait_for_settle):
 * a detached holder keeps queueing and updates `.ci/odu-lease.json` so re-calls
 * observe the line. Never blocks the MCP session on a multi-hour queue.
 */

import { z } from "zod";
import type { BespokeTool } from "@kolu/surface-mcp";
import { leaseCommand, releaseCommand } from "../cli/leaseCmd";
import type { HolderInfo } from "../coordinator/lease";

export const leaseInput = z.object({
  platforms: z.array(z.string()).optional(),
  no_wait: z.boolean().optional(),
});
export type LeaseInput = z.infer<typeof leaseInput>;

export interface LeaseToolResult {
  ok: boolean;
  results: Array<{
    platform: string;
    status: "held" | "waiting" | "already";
    host: string | null;
    holderPid?: number;
    waitingBehind?: HolderInfo | null;
    message: string;
  }>;
}

export const leaseTool: BespokeTool = {
  description:
    "Hold a free venue machine per platform across discrete tool calls " +
    "(agent layer). Returns immediately: held {host} or waiting {behind}. " +
    "Re-call or use hosts to observe the queue. odu run reuses held hosts " +
    "without re-claiming. Call release when done.",
  input: leaseInput,
  mutates: true,
  handler: async (input): Promise<LeaseToolResult> => {
    const args = input as LeaseInput;
    const r = await leaseCommand({
      platforms: args.platforms ?? [],
      noWait: args.no_wait ?? false,
      nonBlocking: true,
    });
    return {
      ok: r.results.every(
        (x) => x.status === "held" || x.status === "already",
      ),
      results: r.results.map((x) => ({
        platform: x.platform,
        status: x.status,
        host: x.host,
        holderPid: x.holderPid,
        waitingBehind: x.waitingBehind ?? null,
        message: x.message,
      })),
    };
  },
};

export const releaseInput = z.object({
  platforms: z.array(z.string()).optional(),
});
export type ReleaseInput = z.infer<typeof releaseInput>;

export interface ReleaseToolResult {
  ok: boolean;
  code: number;
}

export const releaseTool: BespokeTool = {
  description:
    "Drop agent-held venue lease(s) from odu lease (SIGTERM holder process). " +
    "Omit platforms to release all agent-held leases in this checkout.",
  input: releaseInput,
  mutates: true,
  handler: async (input): Promise<ReleaseToolResult> => {
    const args = input as ReleaseInput;
    const code = releaseCommand({
      platforms: args.platforms ?? [],
    });
    return { ok: code === 0, code };
  },
};
