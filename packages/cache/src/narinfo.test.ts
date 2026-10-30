/**
 * The narinfo format, the fingerprint, and Nix's key format.
 *
 * The base32 vector is a REAL narinfo from cache.nixos.org, because the only
 * thing that can tell you whether a hash spelling is right is a client that
 * already agreed with Nix. The rest is round-trip and refusal: a narinfo odu
 * writes must parse back, and one it cannot parse must say so rather than
 * produce a plausible empty record.
 */

import { describe, expect, it } from "bun:test";
import {
  base32,
  canonicalNarHash,
  fingerprintOf,
  formatNarinfo,
  generateKeypair,
  narHashBase32,
  NarinfoError,
  parseNarinfo,
  publicKeyOf,
  signFingerprint,
  storePathHash,
  storePathBasename,
  verifySignature,
} from "./narinfo";

const HELLO = "/nix/store/pa6rydwgjxxmmvdxap7qk9c85h8jbimy-hello-2.12.3";
const GLIBC = "/nix/store/pqyiidz5mi73wv5f91d48s9plcqyj5bz-glibc-2.44-57";
const HELLO_NAR_BASE32 = "0b56hsfzp1d4kx9j095zk64b0zmi189s3ih8mk2zyshpi48fgw76";

/** Verbatim from https://cache.nixos.org/pa6rydwgjxxmmvdxap7qk9c85h8jbimy.narinfo */
const REAL_NARINFO = `StorePath: ${HELLO}
URL: nar/${HELLO_NAR_BASE32}.nar.zst
Compression: zstd
FileHash: sha256:0wx6msiqs479r2w59lp50shbgwwl5rac0aiwlha80mljvgri8s59
FileSize: 76019
NarHash: sha256:${HELLO_NAR_BASE32}
NarSize: 279592
References: pa6rydwgjxxmmvdxap7qk9c85h8jbimy-hello-2.12.3 pqyiidz5mi73wv5f91d48s9plcqyj5bz-glibc-2.44-57
Deriver: y1kh9arkh7w7am664yqbnnrfpsisqcdc-hello-2.12.3.drv
Sig: cache.nixos.org-1:8Ol388OsxflP7RcRY4UePul8PK02UCyf4xrcarBhfqP7gfoDdyMo5Tn0Ef4BWA94qsfMeWXOQsEk7V/aJTr9AA==
`;

describe("nix base32", () => {
  it("matches the hash a real cache publishes", () => {
    const sri = "sha256-5vDnEIkXav/FrAjGoRMKsX6wiJm/JCBTn6SF+52Gpiw=";
    expect(base32(Buffer.from(sri.slice("sha256-".length), "base64"))).toBe(
      HELLO_NAR_BASE32,
    );
    expect(narHashBase32(sri)).toBe(HELLO_NAR_BASE32);
    expect(canonicalNarHash(sri)).toBe(`sha256:${HELLO_NAR_BASE32}`);
  });

  it("round-trips a canonical hash unchanged", () => {
    expect(narHashBase32(`sha256:${HELLO_NAR_BASE32}`)).toBe(HELLO_NAR_BASE32);
  });

  it("refuses a hash it cannot spell", () => {
    expect(() => narHashBase32("sha512-abc")).toThrow(NarinfoError);
    expect(() => narHashBase32("sha256-AAAA")).toThrow(NarinfoError);
    expect(() => narHashBase32("sha256:not-base32")).toThrow(NarinfoError);
  });
});

describe("store paths", () => {
  it("splits the hash from the name", () => {
    expect(storePathHash(HELLO)).toBe("pa6rydwgjxxmmvdxap7qk9c85h8jbimy");
    expect(storePathBasename(HELLO)).toBe("pa6rydwgjxxmmvdxap7qk9c85h8jbimy-hello-2.12.3");
  });

  it("refuses something that is not a store path", () => {
    expect(() => storePathHash("/nix/store/short-name")).toThrow(NarinfoError);
    expect(() => storePathHash("hello")).toThrow(NarinfoError);
  });
});

describe("narinfo", () => {
  it("parses the real thing", () => {
    const info = parseNarinfo(REAL_NARINFO);
    expect(info.storePath).toBe(HELLO);
    expect(info.url).toBe(`nar/${HELLO_NAR_BASE32}.nar.zst`);
    expect(info.compression).toBe("zstd");
    expect(info.fileSize).toBe(76019);
    expect(info.narHash).toBe(`sha256:${HELLO_NAR_BASE32}`);
    expect(info.narSize).toBe(279592);
    expect(info.references).toEqual([HELLO, GLIBC]);
    expect(info.deriver).toBe("/nix/store/y1kh9arkh7w7am664yqbnnrfpsisqcdc-hello-2.12.3.drv");
    expect(info.sigs).toHaveLength(1);
  });

  it("writes references and the deriver as basenames, and reads them back", () => {
    const info = parseNarinfo(REAL_NARINFO);
    const text = formatNarinfo(info);
    expect(text).toContain(
      "References: pa6rydwgjxxmmvdxap7qk9c85h8jbimy-hello-2.12.3 pqyiidz5mi73wv5f91d48s9plcqyj5bz-glibc-2.44-57",
    );
    expect(text).toContain("Deriver: y1kh9arkh7w7am664yqbnnrfpsisqcdc-hello-2.12.3.drv");
    expect(parseNarinfo(text)).toEqual(info);
  });

  it("ignores a field it does not know, and keeps the ones it does", () => {
    const info = parseNarinfo(`${REAL_NARINFO}CA: fixed:r:sha256:abc\n`);
    expect(info.storePath).toBe(HELLO);
  });

  it("refuses a narinfo missing what a client needs", () => {
    expect(() => parseNarinfo("URL: nar/x.nar.zst\n")).toThrow(/StorePath/);
    expect(() => parseNarinfo(`StorePath: ${HELLO}\nNarSize: 1\n`)).toThrow(/NarHash/);
    expect(() => parseNarinfo(`StorePath: ${HELLO}\nNarHash: sha256:${HELLO_NAR_BASE32}\n`)).toThrow(
      /NarSize/,
    );
    expect(() =>
      parseNarinfo(`StorePath: ${HELLO}\nNarHash: sha256:${HELLO_NAR_BASE32}\nNarSize: lots\n`),
    ).toThrow(/NarSize/);
  });
});

describe("the fingerprint", () => {
  it("is Nix's own spelling", () => {
    expect(
      fingerprintOf({
        storePath: HELLO,
        narHash: `sha256:${HELLO_NAR_BASE32}`,
        narSize: 279592,
        references: [HELLO, GLIBC],
      }),
    ).toBe(`1;${HELLO};sha256:${HELLO_NAR_BASE32};279592;${HELLO},${GLIBC}`);
  });

  it("normalises an SRI hash before signing", () => {
    expect(
      fingerprintOf({
        storePath: HELLO,
        narHash: "sha256-5vDnEIkXav/FrAjGoRMKsX6wiJm/JCBTn6SF+52Gpiw=",
        narSize: 279592,
        references: [],
      }),
    ).toBe(`1;${HELLO};sha256:${HELLO_NAR_BASE32};279592;`);
  });
});

describe("ed25519 keys", () => {
  it("generates Nix's spelling and signs what it verifies", () => {
    const keypair = generateKeypair("bucket-1");
    expect(keypair.publicKey.startsWith("bucket-1:")).toBe(true);
    expect(Buffer.from(keypair.publicKey.split(":")[1] as string, "base64")).toHaveLength(32);
    expect(Buffer.from(keypair.secretKey.split(":")[1] as string, "base64")).toHaveLength(64);

    const fingerprint = fingerprintOf({
      storePath: HELLO,
      narHash: `sha256:${HELLO_NAR_BASE32}`,
      narSize: 279592,
      references: [HELLO],
    });
    const signature = signFingerprint(keypair.secretKey, fingerprint);
    expect(signature.startsWith("bucket-1:")).toBe(true);
    expect(verifySignature(keypair.publicKey, fingerprint, signature)).toBe(true);
  });

  it("derives the public half from the secret half", () => {
    const keypair = generateKeypair("bucket-1");
    expect(publicKeyOf(keypair.secretKey)).toBe(keypair.publicKey);
  });

  it("refuses a signature over something else, by another key, or under another name", () => {
    const a = generateKeypair("a-1");
    const b = generateKeypair("b-1");
    const fingerprint = "1;/nix/store/x;sha256:abc;1;";
    const signature = signFingerprint(a.secretKey, fingerprint);

    expect(verifySignature(a.publicKey, `${fingerprint} `, signature)).toBe(false);
    expect(verifySignature(b.publicKey, fingerprint, signature)).toBe(false);
    // The NAME is part of the signature: Nix picks the trusted key by it, so a
    // correct signature carrying somebody else's name is not a signature by
    // that key.
    expect(verifySignature(`b-1:${a.publicKey.split(":")[1] as string}`, fingerprint, signature)).toBe(
      false,
    );
    expect(verifySignature(a.publicKey, fingerprint, "garbage")).toBe(false);
  });

  it("refuses a secret key that is not 64 bytes", () => {
    expect(() => publicKeyOf("k:AAAA")).toThrow(NarinfoError);
    expect(() => signFingerprint("k:AAAA", "1;")).toThrow(NarinfoError);
    expect(() => publicKeyOf("nocolon")).toThrow(NarinfoError);
  });
});
