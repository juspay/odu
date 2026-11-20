import { describe, expect, it } from "bun:test";
import { contentAddressOf, storePathHashOf, base32Bytes } from "./storePath";
import { NIX_RECORDED } from "../test/nixRecorded";

const RUNNER = {
  storePath: "/nix/store/0ng8ghb7myw4mlmf0kv3w8wzy80n4w3n-odu-runner",
  narHash: "sha256:0x3qdfmwxdqc2bkmk4mpb1wsrk9yirn3jg1if5k6k0hzzl543s3g",
  references: [
    "/nix/store/05laqn50w2sym7zzxbik6c68yd14xb42-bash-interactive-5.3p15",
    "/nix/store/2q2f55wqhbzy2wbjs30pz0ppj4r7rq3a-bash-5.3p15",
    "/nix/store/5bm8q9jzkh2pykbkyr6yr21cmjsh2qcq-just-1.57.0",
    "/nix/store/8j0kha3xbrmcwagdb39qxqblw4237qaf-util-linux-2.42.2-bin",
    "/nix/store/bsnpjxnxh4nqk2bsxqff1n1vw0lvm3ql-git-2.55.0",
    "/nix/store/n3bsm9g05rb8xbdc4dgvbnnh3rnpn7kd-bun-1.3.13",
    "/nix/store/nap4zqjc80i5ikjyp0s8r035fa8jqyfn-coreutils-9.11",
    "/nix/store/vsazx16bvji42d2ha0819lzlygni5nbr-odu-base-0.1.0",
  ],
};

describe("contentAddressOf", () => {
  it("proves a real content-addressed path from its narinfo fields", () => {
    expect(contentAddressOf(RUNNER)).toBe(
      "fixed:r:sha256:0x3qdfmwxdqc2bkmk4mpb1wsrk9yirn3jg1if5k6k0hzzl543s3g",
    );
  });

  it("refuses an ordinary input-addressed path", () => {
    expect(
      contentAddressOf({
        storePath: "/nix/store/pa6rydwgjxxmmvdxap7qk9c85h8jbimy-hello-2.12.3",
        narHash: "sha256:0gq7dw760gqz235k8rmx4qcb6p5bc87m4lnxxa1aqlc3p12rdx4z",
        references: [],
      }),
    ).toBeNull();
  });

  it("refuses a self-referencing path without its modulo hash", () => {
    expect(
      contentAddressOf({
        storePath: "/nix/store/6gyc4k1ilcw1k97kf3dnzwia3rq6vakd-selfref",
        narHash: "sha256:0nhllj6n6swi6w1b8290hj2jdpn14q44552mr1lz3xc634azh3ng",
        references: ["/nix/store/6gyc4k1ilcw1k97kf3dnzwia3rq6vakd-selfref"],
      }),
    ).toBeNull();
  });

  it("proves a self-reference from whichever form of its modulo hash rebuilds it", () => {
    const zero = `sha256:${"0".repeat(52)}`;
    const facts = (vector: { storePath: string; narHash: string }) => ({
      storePath: vector.storePath,
      narHash: vector.narHash,
      references: [vector.storePath],
    });
    const v234 = facts(NIX_RECORDED.selfref234);
    const v235 = facts(NIX_RECORDED.selfref235);
    const hash234 = `sha256:${NIX_RECORDED.selfref234.ca.slice("fixed:r:sha256:".length)}`;
    const hash235 = `sha256:${NIX_RECORDED.selfref235.ca.slice("fixed:r:sha256:".length)}`;
    expect(contentAddressOf({ ...v234, selfHash: { withoutOffsets: hash234, withOffsets: zero } })).toBe(
      NIX_RECORDED.selfref234.ca,
    );
    expect(contentAddressOf({ ...v234, selfHash: { withoutOffsets: zero, withOffsets: hash234 } })).toBe(
      NIX_RECORDED.selfref234.ca,
    );
    expect(contentAddressOf({ ...v235, selfHash: { withoutOffsets: zero, withOffsets: hash235 } })).toBe(
      NIX_RECORDED.selfref235.ca,
    );
    expect(contentAddressOf({ ...v235, selfHash: { withoutOffsets: hash234, withOffsets: zero } })).toBeNull();
    expect(contentAddressOf({ ...v234, selfHash: { withoutOffsets: zero, withOffsets: zero } })).toBeNull();
  });

  it("matches Nix's makeStorePath for the self vector's own hash", () => {
    const hash = "163ryiah9ms80qck6zb6dpy7sz9db61pjx460983wd3yyb41r7gl";
    expect(storePathHashOf("source:self", base32Bytes(hash), "selfref")).toBe(
      "6gyc4k1ilcw1k97kf3dnzwia3rq6vakd",
    );
  });
});
