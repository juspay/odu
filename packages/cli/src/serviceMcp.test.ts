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
    expect(Object.keys(mountedRows(["ci", "cache", "auth"])).sort()).toEqual(["auth", "cache"]);
    expect(Object.keys(mountedRows(["ci"]))).toEqual([]);
  });

  it("offers what every daemon mounts while the roster is unanswered, and nothing it would guess", () => {
    expect(Object.keys(mountedRows(null)).sort()).toEqual(["cache", "metrics"]);
    expect(Object.keys(mountedRows(["ci", "cache", "metrics"])).sort()).toEqual([
      "cache",
      "metrics",
    ]);
  });

  it("exposes the tunnel's status read with no input", () => {
    expect(ODU_CLOUDFLARE_EXPOSE["status.read"]).toEqual({ tool: { mutates: false } });
    const read = oduCloudflareSurface.spec.procedures?.status?.read as
      | { input?: unknown }
      | undefined;
    expect(read?.input).toBeUndefined();
  });
});
