/**
 * VECTORS FROM NIX, not from the formula's own implementation.
 *
 * `0ng8ghb7…-odu-runner` is a real path from the kolu bucket, with the
 * references and NarHash its narinfo carries. `6gyc…-selfref` is
 * `nix build` output containing its own store path, then
 * `nix store make-content-addressed`; a self-reference's CA hash is the modulo
 * hash of its NAR, supplied by the byte pass — metadata alone (NarHash) cannot
 * prove it.
 */
import { describe, expect, it } from "bun:test";
import { contentAddressOf, storePathHashOf, base32Bytes } from "./storePath";

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
    // NIX 2.34 wrote 6gyc…'s CA from the zeroed bytes alone; Nix 2.35 wrote
    // j9xp…'s, from the same derivation, with `|107` after them. Each is
    // proved by its own form, in either slot: the path decides, not the slot.
    const zero = `sha256:${"0".repeat(52)}`;
    const v234 = {
      storePath: "/nix/store/6gyc4k1ilcw1k97kf3dnzwia3rq6vakd-selfref",
      narHash: "sha256:0nhllj6n6swi6w1b8290hj2jdpn14q44552mr1lz3xc634azh3ng",
      references: ["/nix/store/6gyc4k1ilcw1k97kf3dnzwia3rq6vakd-selfref"],
    };
    const ca234 = "163ryiah9ms80qck6zb6dpy7sz9db61pjx460983wd3yyb41r7gl";
    expect(
      contentAddressOf({ ...v234, selfHash: { withoutOffsets: `sha256:${ca234}`, withOffsets: zero } }),
    ).toBe(`fixed:r:sha256:${ca234}`);
    expect(
      contentAddressOf({ ...v234, selfHash: { withoutOffsets: zero, withOffsets: `sha256:${ca234}` } }),
    ).toBe(`fixed:r:sha256:${ca234}`);

    const v235 = {
      storePath: "/nix/store/j9xpm5a9yzp9v5slnxsgvay2lnwqi2l6-selfref",
      narHash: "sha256-XUFNQ9+fHf+Zow3TLUYxj/5FPxAn9wKBcq+ia2Q3PRM=",
      references: ["/nix/store/j9xpm5a9yzp9v5slnxsgvay2lnwqi2l6-selfref"],
    };
    const ca235 = "14869lj9vs5fmpd0f1p5msrn1jdl7hd146xaimv4l6zivgmc71zl";
    expect(
      contentAddressOf({ ...v235, selfHash: { withoutOffsets: zero, withOffsets: `sha256:${ca235}` } }),
    ).toBe(`fixed:r:sha256:${ca235}`);
    // ONE PATH'S HASH DOES NOT PROVE ANOTHER PATH, and neither form proving
    // it is `null`, not a guess.
    expect(
      contentAddressOf({
        ...v235,
        selfHash: { withoutOffsets: `sha256:${ca234}`, withOffsets: zero },
      }),
    ).toBeNull();
    expect(contentAddressOf({ ...v234, selfHash: { withoutOffsets: zero, withOffsets: zero } })).toBeNull();
  });

  it("matches Nix's makeStorePath for the self vector's own hash", () => {
    // `nix path-info` reports this path's CA as fixed:r:sha256:163ry…
    // The TYPE for a self reference is `source:self`, and with that hash the
    // formula reproduces the path exactly — which is why a CA hash WOULD prove
    // it, and a NarHash cannot.
    const hash = "163ryiah9ms80qck6zb6dpy7sz9db61pjx460983wd3yyb41r7gl";
    expect(storePathHashOf("source:self", base32Bytes(hash), "selfref")).toBe(
      "6gyc4k1ilcw1k97kf3dnzwia3rq6vakd",
    );
  });
});
