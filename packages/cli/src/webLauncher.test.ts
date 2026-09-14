/**
 * ADOPT OR REFUSE — the thin-client handshake. These tests defend the one
 * regression the module doc now promises: a dial that answers is adopted only
 * if its service cell's contract is compatible with THIS build, and anything
 * else is refused with an honest sentence rather than surfacing later as an
 * `Unknown request tag` from inside the RPC layer. The cell read is scripted —
 * `service.get` is handed a one-frame Stream — so the unit is tested without a
 * socket; the failure it defends is the adoption decision and the disposal
 * discipline on refusal.
 */

import { describe, expect, it } from "bun:test";
import { Effect, Stream } from "effect";
import type { OduServiceClient, ServiceCell } from "@odu/service-client/surface";
import { SERVICE_CONTRACT_VERSION, UNKNOWN_SERVICE } from "@odu/service-client/surface";
import type { ServiceConnection } from "@odu/service-client/dial";
import { adoptOrRefuse, contractVerdict } from "./webLauncher";

const ORIGIN = "http://127.0.0.1:3737";

/** A contract version one minor step from this build's, in either direction. */
function minorStep(steps: number): string {
  const [major, minor] = SERVICE_CONTRACT_VERSION.split(".");
  return `${major}.${Number(minor) + steps}`;
}

function cell(protocolVersion: string): ServiceCell {
  return {
    ...UNKNOWN_SERVICE,
    identity: { ...UNKNOWN_SERVICE.identity, protocolVersion },
  };
}

/** A connection whose `service.get` runs `get`, counting disposes. The fake's
 *  `url` matches what `dialService` really produces (a websocket route, not an
 *  origin) so the fixture does not teach that the two fields are the same. */
function scripted(get: () => unknown): {
  connection: ServiceConnection;
  disposed: () => number;
} {
  let disposes = 0;
  const connection = {
    client: {
      surface: {
        service: { get },
      },
    } as unknown as OduServiceClient,
    dispatch: null as unknown as ServiceConnection["dispatch"],
    url: "ws://127.0.0.1:3737/rpc/ws",
    dispose: async () => {
      disposes += 1;
    },
  };
  return { connection, disposed: () => disposes };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

describe("adoptOrRefuse", () => {
  it("refuses a service whose minor is BEHIND this build, and disposes", async () => {
    const behind = minorStep(-1);
    const { connection, disposed } = scripted(() => Stream.make(cell(behind)));

    const rejection = await adoptOrRefuse(connection, ORIGIN).then(
      () => null,
      (err: unknown) => err,
    );
    // The ONE sentence, asserted by identity against the shared verdict rather
    // than as substrings — so a rewording fails the test instead of drifting.
    const verdict = contractVerdict(cell(behind), ORIGIN);
    if (verdict === null) throw new Error("behind-minor fixture must refuse");
    expect(messageOf(rejection)).toBe(verdict);
    expect(disposed()).toBe(1);
  });

  it("adopts a service whose minor is AHEAD of this build, without disposing", async () => {
    const ahead = minorStep(1);
    const { connection, disposed } = scripted(() => Stream.make(cell(ahead)));

    const result = await adoptOrRefuse(connection, ORIGIN);
    expect(result).toBe(connection);
    expect(disposed()).toBe(0);
  });

  it("refuses a service that fails the cell read, and disposes", async () => {
    const { connection, disposed } = scripted(() => Effect.fail("the link died"));

    await expect(adoptOrRefuse(connection, ORIGIN)).rejects.toThrow(
      /published no service cell/,
    );
    expect(disposed()).toBe(1);
  });

  // The fixture must be BEHIND, not malformed: at a future `x.0` bump
  // `minor - 1` is `-1`, which the framework's grammar rejects outright — the
  // tests above would still pass, for the wrong reason, and stop pinning the
  // ordering this module documents. Assert the fixtures mean what the test
  // names claim.
  it("uses fixtures that are genuinely a lower and a higher minor", () => {
    expect(contractVerdict(cell(minorStep(-1)), ORIGIN)).not.toBeNull();
    expect(contractVerdict(cell(minorStep(1)), ORIGIN)).toBeNull();
  });
});