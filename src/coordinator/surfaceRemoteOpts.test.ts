import { describe, expect, it } from "vitest";
import { localhostSpawnEnv } from "./surfaceRemoteOpts";

describe("localhostSpawnEnv", () => {
  it("keeps the macOS Nix session while dropping ambient secrets", () => {
    expect(
      localhostSpawnEnv({
        HOME: "/Users/runner",
        PATH: "/nix/bin:/usr/bin",
        TMPDIR: "/var/folders/runner/T",
        NIX_PROFILES: "/nix/var/nix/profiles/default",
        NIX_USER_PROFILE_DIR: "/nix/var/nix/profiles/per-user/runner",
        NIX_SSL_CERT_FILE: "/etc/ssl/cert.pem",
        GITHUB_TOKEN: "secret",
        CLAUDE_CODE_CHILD_SESSION: "identity",
      }),
    ).toEqual({
      HOME: "/Users/runner",
      PATH: "/nix/bin:/usr/bin",
      TMPDIR: "/var/folders/runner/T",
      NIX_PROFILES: "/nix/var/nix/profiles/default",
      NIX_USER_PROFILE_DIR: "/nix/var/nix/profiles/per-user/runner",
      NIX_SSL_CERT_FILE: "/etc/ssl/cert.pem",
    });
  });
});
