import { describe, expect, it } from "bun:test";
import { Effect, Stream } from "effect";
import type { OduServiceClient, ServiceCell } from "@odu/service-client/surface";
import {
  CI_CONTRACT_VERSION,
  CI_NEEDS,
  CI_ROW,
  HOST_CONTRACT_VERSION,
  UNKNOWN_SERVICE,
} from "@odu/service-client/surface";
import type { ServiceConnection } from "@odu/service-client/dial";
import { adoptOrRefuse, contractVerdict } from "./webLauncher";

const ORIGIN = "http://127.0.0.1:3737";

function majorStep(steps: number): string {
  const [major, minor] = HOST_CONTRACT_VERSION.split(".");
  return `${Number(major) + steps}.${minor}`;
}

function minorStep(steps: number): string {
  const [major, minor] = HOST_CONTRACT_VERSION.split(".");
  return `${major}.${Number(minor) + steps}`;
}

function cell(protocolVersion: string): ServiceCell {
  return {
    ...UNKNOWN_SERVICE,
    identity: {
      ...UNKNOWN_SERVICE.identity,
      protocolVersion,
      rows: { [CI_ROW]: CI_CONTRACT_VERSION },
    },
  };
}

const NEEDS = { needs: CI_NEEDS };

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

    const rejection = await adoptOrRefuse(connection, ORIGIN, NEEDS).then(
      () => null,
      (err: unknown) => err,
    );
    const verdict = contractVerdict(cell(other), ORIGIN, CI_NEEDS);
    if (verdict === null) throw new Error("other-major fixture must refuse");
    expect(messageOf(rejection)).toBe(verdict);
    expect(disposed()).toBe(1);
  });

  it("adopts a service whose minor is BEHIND this build — the additive rule", async () => {
    const warned: string[] = [];
    const { connection, disposed } = scripted(() => Stream.make(cell(minorStep(-1))));
    const result = await adoptOrRefuse(connection, ORIGIN, {
      ...NEEDS,
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
      const { connection } = scripted(() => Stream.make(cell(minorStep(-1))));
      await adoptOrRefuse(connection, ORIGIN, {
        ...NEEDS,
        warn: (line) => warned.push(line),
        warned: seen,
      });
    }
    expect(warned).toHaveLength(1);
  });

  it("says nothing when the service is level or ahead", async () => {
    const warned: string[] = [];
    for (const version of [HOST_CONTRACT_VERSION, minorStep(1)]) {
      const { connection } = scripted(() => Stream.make(cell(version)));
      await adoptOrRefuse(connection, ORIGIN, { ...NEEDS, warn: (line) => warned.push(line) });
    }
    expect(warned).toEqual([]);
  });

  it("adopts a service whose minor is AHEAD of this build, without disposing", async () => {
    const ahead = minorStep(1);
    const { connection, disposed } = scripted(() => Stream.make(cell(ahead)));

    const result = await adoptOrRefuse(connection, ORIGIN, NEEDS);
    expect(result).toBe(connection);
    expect(disposed()).toBe(0);
  });

  it("refuses a service that fails the cell read, and disposes", async () => {
    const { connection, disposed } = scripted(() => Effect.fail("the link died"));

    await expect(adoptOrRefuse(connection, ORIGIN, NEEDS)).rejects.toThrow(
      /published no service cell/,
    );
    expect(disposed()).toBe(1);
  });

  it("refuses a service whose cell read never answers, within the handshake deadline", async () => {
    const { connection, disposed } = scripted(() => Stream.never);

    await expect(
      adoptOrRefuse(connection, ORIGIN, { ...NEEDS, handshakeMs: 50 }),
    ).rejects.toThrow(/did not answer the handshake/);
    expect(disposed()).toBe(1);
  });

  it("refuses a service whose cell read answers with nothing, and disposes", async () => {
    const { connection, disposed } = scripted(() => Stream.empty);

    await expect(adoptOrRefuse(connection, ORIGIN, NEEDS)).rejects.toThrow(
      /published no service cell/,
    );
    expect(disposed()).toBe(1);
  });

  it("uses fixtures that are genuinely a lower minor, a higher minor and another major", () => {
    expect(contractVerdict(cell(minorStep(-1)), ORIGIN, CI_NEEDS)).toBeNull();
    expect(contractVerdict(cell(minorStep(1)), ORIGIN, CI_NEEDS)).toBeNull();
    expect(contractVerdict(cell(majorStep(1)), ORIGIN, CI_NEEDS)).not.toBeNull();
    expect(contractVerdict(cell(majorStep(-1)), ORIGIN, CI_NEEDS)).not.toBeNull();
    expect(contractVerdict(cell(""), ORIGIN, CI_NEEDS)).not.toBeNull();
    expect(contractVerdict(cell("2.1garbage"), ORIGIN, CI_NEEDS)).not.toBeNull();
  });
});
