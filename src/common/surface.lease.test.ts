import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { DEFAULT_LEASE_LOCK, laneSurface } from "./surface";

/**
 * Venue lease must stay on the lane agent surface (surface-remote dial),
 * not a parallel bash-over-ssh protocol. These checks pin that product
 * contract so a regression cannot reintroduce host-PATH flock scripts.
 */
describe("laneSurface lease procedures", () => {
  it("advertises claim, probe and release as lane surface routes", () => {
    // Restated on the tag axis: the oRPC `contract` tree is gone, and a
    // surface's identity is now its flat route set — the exact keys
    // `defineSurface` minted and `implementSurface` asserts handlers for at
    // boot. Reading `group.requests` is reading what a peer can actually call.
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
    // The false-BUSY bug lived in claimRemoteScript + buildLeaseSshArgs.
    expect(src).not.toMatch(/claimRemoteScript/);
    expect(src).not.toMatch(/buildLeaseSshArgs/);
    expect(src).not.toMatch(/probeRemoteScript/);
  });
});
