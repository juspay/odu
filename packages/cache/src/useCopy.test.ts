/**
 * ONE SOURCE FOR THE BLOCKS A PERSON COPIES.
 *
 * A bucket's page prints five paste-blocks (plus netrc on a private bucket) —
 * four for a Nix client, one for a workflow — and `odu cache use` prints the
 * same strings; the cache docs quote them. The docs are prose nobody compiles,
 * so the only thing that keeps them from drifting is this: the docs must
 * contain exactly what each function prints for the docs' example bucket,
 * placeholder and all.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  actionsBlock,
  actionsPushBlock,
  ACTION_REF_PLACEHOLDER,
  flakeBlock,
  netrcBlock,
  nixConfBlock,
  nixOsBlock,
  pushBlock,
  READ_TOKEN_PLACEHOLDER,
  useBlock,
  useCommand,
  WRITE_TOKEN_PLACEHOLDER,
} from "./surface";

const DOCS = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "website", "src", "content", "cache.md"),
  "utf-8",
);

const URL = "http://127.0.0.1:18440/cache/main";
const KEY = "main-1:<public-key>";

describe("the copy a bucket page and the docs share", () => {
  it("the docs quote every block the page prints", () => {
    for (const text of [
      nixConfBlock({ url: URL, publicKey: KEY }),
      nixOsBlock({ url: URL, publicKey: KEY }),
      flakeBlock({ url: URL, publicKey: KEY }),
      actionsBlock({ url: URL, publicKey: KEY }),
      netrcBlock({ url: URL, home: null }),
    ]) {
      expect({ text, quoted: DOCS.includes(text.trimEnd()) }).toEqual({ text, quoted: true });
    }
  });

  it("the docs quote the push block the page prints", () => {
    expect(DOCS).toContain(
      pushBlock({ origin: "https://odu.example.com", bucket: "main", token: null }).trimEnd(),
    );
  });

  it("the docs quote the GitHub Actions push block the page prints", () => {
    expect(DOCS).toContain(
      actionsPushBlock({
        origin: "https://odu.example.com",
        bucket: "main",
        ref: ACTION_REF_PLACEHOLDER,
      }).trimEnd(),
    );
  });

  it("names the bucket and the origin in the action's inputs, and the token as a secret", () => {
    const origin = "https://odu.example.com";
    const block = actionsPushBlock({ origin, bucket: "main", ref: ACTION_REF_PLACEHOLDER });
    // The two facts a page knows are filled in; the one it must not know is
    // not: the token is a `secrets.` reference, never a value.
    expect(block).toContain(`origin: ${origin}`);
    expect(block).toContain("bucket: main");
    expect(block).toContain("token: ${{ secrets.ODU_CACHE_TOKEN }}");
    expect(block).toContain("uses: juspay/odu/.github/actions/push@");
    // Pinned by revision, because the action builds the pusher from the commit
    // it is pinned to. The PLACEHOLDER is what a build that cannot name its
    // commit offers; a daemon that can offers its own.
    expect(block).toContain(ACTION_REF_PLACEHOLDER);
    expect(actionsPushBlock({ origin, bucket: "main", ref: "abc1234" })).toContain(
      "uses: juspay/odu/.github/actions/push@abc1234",
    );
  });

  it("fills in a just-minted token, and the placeholder otherwise", () => {
    const origin = "https://odu.example.com";
    expect(pushBlock({ origin, bucket: "main", token: "odc_secret" })).toContain(
      "export ODU_CACHE_TOKEN=odc_secret",
    );
    expect(pushBlock({ origin, bucket: "main", token: null })).toContain(
      `ODU_CACHE_TOKEN=${WRITE_TOKEN_PLACEHOLDER}`,
    );
    expect(pushBlock({ origin, bucket: "main", token: null })).toContain(
      `odu cache push main <paths> --origin ${origin}`,
    );
  });

  it("names the credential each block needs", () => {
    const use = useBlock({ url: URL, publicKey: KEY, home: null });
    // A private bucket READS with a read token; a push WRITES with a write one.
    expect(use).toContain(`password ${READ_TOKEN_PLACEHOLDER}`);
    expect(use).toContain("extra-substituters");
    expect(useCommand("main")).toBe("odu cache use main");
  });
});
