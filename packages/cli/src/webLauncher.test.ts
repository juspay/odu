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
import { adoptOrRefuse } from "./webLauncher";
import { errorMessage } from "./serviceFace";

/** A connection whose `service.get` yields `cell`, counting disposes. */
function scripted(opts: {
  cell: ServiceCell;
  failGet?: boolean;
}): { connection: ServiceConnection; disposed: () => number } {
  let disposes = 0;
  const connection = {
    client: {
      surface: {
        service: {
          get: () =>
            opts.failGet
              ? Effect.fail("the link died")
              : Stream.make(opts.cell),
        },
      },
    } as unknown as OduServiceClient,
    dispatch: null as unknown as ServiceConnection["dispatch"],
    url: "http://127.0.0.1:3737",
    dispose: async () => {
      disposes += 1;
    },
  };
  return { connection, disposed: () => disposes };
}

function cell(protocolVersion: string): ServiceCell {
  return {
    ...UNKNOWN_SERVICE,
    identity: { ...UNKNOWN_SERVICE.identity, protocolVersion },
  };
}

const [majorStr, minorStr] = SERVICE_CONTRACT_VERSION.split(".");
const major = Number(majorStr);
const minor = Number(minorStr);
describe("adoptOrRefuse", () => {
  it("refuses a service whose minor is BEHIND this build, and disposes", async () => {
    const behind = `${major}.${minor - 1}`;
    const { connection, disposed } = scripted({ cell: cell(behind) });

    const rejection = await adoptOrRefuse(connection, connection.url).then(
      () => null,
      (err: unknown) => err,
    );
    expect(String(rejection)).toContain(`speaks contract ${behind};`);
    expect(String(rejection)).toContain("odu web --upgrade");
    expect(disposed()).toBe(1);
  });

  it("adopts a service whose minor is AHEAD of this build, without disposing", async () => {
    const ahead = `${major}.${minor + 1}`;
    const { connection, disposed } = scripted({ cell: cell(ahead) });

    const result = await adoptOrRefuse(connection, connection.url);
    expect(result).toBe(connection);
    expect(disposed()).toBe(0);
  });

  it("refuses a service that fails the cell read, and disposes", async () => {
    const { connection, disposed } = scripted({
      cell: cell(SERVICE_CONTRACT_VERSION),
      failGet: true,
    });

    await expect(adoptOrRefuse(connection, connection.url)).rejects.toThrow(
      /published no service cell/,
    );
    expect(disposed()).toBe(1);
  });
});

describe("errorMessage", () => {
  it("renders an Error's message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
  it("renders a bare string", () => {
    expect(errorMessage("raw line")).toBe("raw line");
  });
  it("renders an object with a string message", () => {
    expect(errorMessage({ message: "nested cause" })).toBe("nested cause");
  });
});