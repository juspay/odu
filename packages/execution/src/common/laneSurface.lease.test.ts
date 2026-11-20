import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { DEFAULT_LEASE_LOCK, laneSurface } from "./laneSurface";

describe("laneSurface lease procedures", () => {
  it("advertises claim, probe and release as lane surface routes", () => {
    const tags = [...laneSurface.group.requests.keys()];
    expect(tags).toContain("surface/lease/claim");
    expect(tags).toContain("surface/lease/probe");
    expect(tags).toContain("surface/lease/release");
  });

  it("defaults the venue lock path to /tmp/odu.lease", () => {
    expect(DEFAULT_LEASE_LOCK).toBe("/tmp/odu.lease");
  });

  it("coordinator lease dials the agent — no bash claim script", () => {
    const src = readFileSync(
      join(import.meta.dirname, "../coordinator/lease.ts"),
      "utf8",
    );
    expect(src).toMatch(/client\.surface\.lease\.claim/);
    expect(src).toMatch(/makeSession/);
    expect(src).toMatch(/sshConnector/);
    expect(src).not.toMatch(/claimRemoteScript/);
    expect(src).not.toMatch(/buildLeaseSshArgs/);
    expect(src).not.toMatch(/probeRemoteScript/);
  });
});
