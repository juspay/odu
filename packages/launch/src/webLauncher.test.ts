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

/** A contract version one major step from this build's. */
function majorStep(steps: number): string {
  const [major, minor] = SERVICE_CONTRACT_VERSION.split(".");
  return `${Number(major) + steps}.${minor}`;
}

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
    onClose: () => () => {},
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
  it("refuses a service on a different MAJOR, and disposes", async () => {
    const other = majorStep(1);
    const { connection, disposed } = scripted(() => Stream.make(cell(other)));

    const rejection = await adoptOrRefuse(connection, ORIGIN).then(
      () => null,
      (err: unknown) => err,
    );
    // The ONE sentence, asserted by identity against the shared verdict rather
    // than as substrings — so a rewording fails the test instead of drifting.
    const verdict = contractVerdict(cell(other), ORIGIN);
    if (verdict === null) throw new Error("other-major fixture must refuse");
    expect(messageOf(rejection)).toBe(verdict);
    expect(disposed()).toBe(1);
  });

  it("adopts a service whose minor is BEHIND this build — the additive rule", async () => {
    // A minor only ADDS members. A build 3.1 reading a 3.0 daemon is the case;
    // the version is a seam here so a major that starts at `.0` can still be
    // tested in the direction that matters.
    const warned: string[] = [];
    const { connection, disposed } = scripted(() => Stream.make(cell("3.0")));
    const result = await adoptOrRefuse(connection, ORIGIN, {
      build: "3.1",
      warn: (line) => warned.push(line),
    });
    expect(result).toBe(connection);
    expect(disposed()).toBe(0);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("odu web --upgrade");
  });

  it("says the behind note once per daemon to a caller that redials", async () => {
    const warned: string[] = [];
    const seen = new Set<string>();
    for (let dial = 0; dial < 3; dial += 1) {
      const { connection } = scripted(() => Stream.make(cell("3.0")));
      await adoptOrRefuse(connection, ORIGIN, {
        build: "3.1",
        warn: (line) => warned.push(line),
        warned: seen,
      });
    }
    expect(warned).toHaveLength(1);
  });

  it("says nothing when the service is level or ahead", async () => {
    const warned: string[] = [];
    for (const version of [SERVICE_CONTRACT_VERSION, minorStep(1)]) {
      const { connection } = scripted(() => Stream.make(cell(version)));
      await adoptOrRefuse(connection, ORIGIN, { warn: (line) => warned.push(line) });
    }
    expect(warned).toEqual([]);
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

  it("refuses a service whose cell read never answers, within the handshake deadline", async () => {
    // The wedged-daemon case: socket is open, no first frame ever arrives.
    // #113 is this, one layer down — without the deadline every thin client
    // would hang on a blank terminal waiting for a snapshot that never comes.
    const { connection, disposed } = scripted(() => Stream.never);

    await expect(
      adoptOrRefuse(connection, ORIGIN, { handshakeMs: 50 }),
    ).rejects.toThrow(/did not answer the handshake/);
    expect(disposed()).toBe(1);
  });

  it("refuses a service whose cell read answers with nothing, and disposes", async () => {
    const { connection, disposed } = scripted(() => Stream.empty);

    await expect(adoptOrRefuse(connection, ORIGIN)).rejects.toThrow(
      /published no service cell/,
    );
    expect(disposed()).toBe(1);
  });

  // A major starts at `.0`, so there is no representable LOWER minor at 3.0;
  // the additive rule is still exercised in the ahead direction.
  it("uses fixtures that are genuinely a lower minor, a higher minor and another major", () => {
    expect(contractVerdict(cell("3.0"), ORIGIN, "3.1")).toBeNull();
    expect(contractVerdict(cell(minorStep(1)), ORIGIN, "3.1")).toBeNull();
    expect(contractVerdict(cell(majorStep(1)), ORIGIN)).not.toBeNull();
    expect(contractVerdict(cell(majorStep(-1)), ORIGIN)).not.toBeNull();
    expect(contractVerdict(cell(""), ORIGIN)).not.toBeNull();
    expect(contractVerdict(cell("2.1garbage"), ORIGIN)).not.toBeNull();
  });
});
