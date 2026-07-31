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
  it("exposes claim, probe, and release on the agent contract", () => {
    const surface = (
      laneSurface.contract as {
        surface?: { lease?: Record<string, unknown> };
      }
    ).surface;
    const lease = surface?.lease;
    expect(lease).toBeDefined();
    expect(lease).toHaveProperty("claim");
    expect(lease).toHaveProperty("probe");
    expect(lease).toHaveProperty("release");
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
