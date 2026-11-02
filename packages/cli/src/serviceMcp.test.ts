/**
 * THE BRIDGE'S ROSTER, from the daemon's composition facts.
 *
 * `odu mcp` advertises exactly the siblings `GET /_odu/rows` lists — the door
 * and the tunnel only when the daemon mounts them — and, while that roster is
 * unanswered, the cache every daemon mounts. A tool for a row that is not there
 * is a tool error on the agent's first call.
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
  it("carries exactly the siblings the roster lists", () => {
    expect(Object.keys(mountedRows(["ci", "cache"]))).toEqual(["cache"]);
    expect(Object.keys(mountedRows(["ci", "cache", CLOUDFLARE_KEY]))).toEqual([
      "cache",
      CLOUDFLARE_KEY,
    ]);
    // The door is on the roster exactly when there is one.
    expect(Object.keys(mountedRows(["ci", "cache", "auth"])).sort()).toEqual(["auth", "cache"]);
    // A row the roster does not list is not advertised, the cache included.
    expect(Object.keys(mountedRows(["ci"]))).toEqual([]);
  });

  it("offers the cache while the roster is unanswered, and nothing it would guess", () => {
    expect(Object.keys(mountedRows(null))).toEqual(["cache"]);
  });

  it("exposes the tunnel's status read with no input", () => {
    expect(ODU_CLOUDFLARE_EXPOSE["status.read"]).toEqual({ tool: { mutates: false } });
    const read = oduCloudflareSurface.spec.procedures?.status?.read as
      | { input?: unknown }
      | undefined;
    expect(read?.input).toBeUndefined();
  });
});
