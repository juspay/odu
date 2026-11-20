import { describe, expect, it } from "bun:test";
import { bucketOf, CACHE_MOUNT, PUSH_API } from "./paths";

describe("the bucket a path names", () => {
  it("answers both protocol spellings, and null for everything else", () => {
    expect(bucketOf(`${CACHE_MOUNT}/kolu/nar/x.nar.zst`)).toBe("kolu");
    expect(bucketOf(`${CACHE_MOUNT}/kolu`)).toBe("kolu");
    expect(bucketOf(`${PUSH_API}/buckets/kolu/missing`)).toBe("kolu");
    expect(bucketOf(`${CACHE_MOUNT}/ko%6cu/${"a".repeat(32)}.narinfo`)).toBe("kolu");
  });

  it("names no bucket outside the two mounts, or on an empty name", () => {
    for (const path of ["/", "/nix-cache-info", "/nar/x.nar.zst", "/assets/app.js", "/mcp"]) {
      expect({ path, bucket: bucketOf(path) }).toEqual({ path, bucket: null });
    }
    expect(bucketOf(`${CACHE_MOUNT}/`)).toBeNull();
    expect(bucketOf(`${PUSH_API}/buckets/`)).toBeNull();
  });
});
