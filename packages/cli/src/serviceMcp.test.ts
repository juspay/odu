/**
 * THE BRIDGE'S ROSTER, from the daemon's composition facts.
 *
 * `odu mcp` composes its siblings the way the daemon composes its rows: the
 * cache always, the tunnel only when the daemon mounts it (asked of
 * `GET /_odu/rows`), and the door only when there is one. A tool for a row that
 * is not there is a tool error on the agent's first call.
 *
 * The tunnel's status read takes NO INPUT — not an empty struct — because an MCP
 * host sends no arguments for a verb with none.
 */

import { describe, expect, it } from "bun:test";
import { mountedRows } from "./serviceMcp";
import {
  CLOUDFLARE_KEY,
  ODU_CLOUDFLARE_EXPOSE,
  oduCloudflareSurface,
} from "@odu/cloudflare/surface";

describe("odu mcp's siblings", () => {
  it("carries the cache always, and the tunnel only when the daemon says so", () => {
    expect(Object.keys(mountedRows(false, ["ci", "cache"]))).toEqual(["cache"]);
    expect(Object.keys(mountedRows(false, ["ci", "cache", CLOUDFLARE_KEY]))).toEqual([
      "cache",
      CLOUDFLARE_KEY,
    ]);
    // An unanswered roster is no cloudflare, not a guess.
    expect(Object.keys(mountedRows(false, null))).toEqual(["cache"]);
  });

  it("adds the door only with a door", () => {
    expect(Object.keys(mountedRows(true, ["ci", "cache"])).sort()).toEqual(["auth", "cache"]);
    expect(Object.keys(mountedRows(null, ["ci", "cache"])).sort()).toEqual(["cache"]);
  });

  it("exposes the tunnel's status read with no input", () => {
    expect(ODU_CLOUDFLARE_EXPOSE["status.read"]).toEqual({ tool: { mutates: false } });
    const read = oduCloudflareSurface.spec.procedures?.status?.read as
      | { input?: unknown }
      | undefined;
    expect(read?.input).toBeUndefined();
  });
});
