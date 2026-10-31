/**
 * ONE SOURCE FOR THE BLOCKS A PERSON COPIES.
 *
 * A bucket's page prints the push block from `pushBlock`, and the cache docs
 * quote it. The docs are prose nobody compiles, so the only thing that keeps
 * them from drifting is this: the docs must contain exactly what the function
 * prints for the docs' example bucket, placeholder and all.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { pushBlock, useBlock, useCommand, WRITE_TOKEN_PLACEHOLDER } from "./surface";

const DOCS = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "website", "src", "content", "cache.md"),
  "utf-8",
);

describe("the copy a bucket page and the docs share", () => {
  it("the docs quote the push block the page prints", () => {
    expect(DOCS).toContain(
      pushBlock({ url: "https://odu.example.com/cache/main", token: null }).trimEnd(),
    );
  });

  it("fills in a just-minted token, and the placeholder otherwise", () => {
    const url = "https://odu.example.com/cache/main";
    expect(pushBlock({ url, token: "odc_secret" })).toContain("export ODU_CACHE_TOKEN=odc_secret");
    expect(pushBlock({ url, token: null })).toContain(`ODU_CACHE_TOKEN=${WRITE_TOKEN_PLACEHOLDER}`);
    expect(pushBlock({ url, token: null })).toContain(`odu cache push ${url} ./result`);
  });

  it("names the token the same way in the push block and the netrc line", () => {
    const use = useBlock({ url: "https://h/cache/main", publicKey: "main-1:k", home: null });
    expect(use).toContain(`password ${WRITE_TOKEN_PLACEHOLDER}`);
    expect(useCommand("main")).toBe("odu cache use main");
  });
});
