import { describe, expect, it } from "vitest";
import { fanoutLanes, resolveLanes } from "./hosts";

describe("resolveLanes", () => {
  const empty = { hosts: {}, source: "(no hosts file)" };

  it("returns nothing for a bare run with no config — the fail-fast trigger", () => {
    expect(resolveLanes(empty, [], [])).toEqual({});
  });

  it("synthesizes a lane from a --host pin even with no config file", () => {
    expect(resolveLanes(empty, ["aarch64-darwin=localhost"], [])).toEqual({
      "aarch64-darwin": "localhost",
    });
  });

  it("errors on --platform with no host — operator asked for a lane we can't build", () => {
    expect(() => resolveLanes(empty, [], ["x86_64-linux"])).toThrow(
      /no host/,
    );
  });
});

describe("fanoutLanes — the no-config fail-fast (juspay/odu#46)", () => {
  const empty = { hosts: {}, source: "(no hosts file)" };

  it("REFUSES a bare run with no hosts config — never a silent localhost lane", () => {
    // The incident: a bare `odu run` with no config anywhere silently resolved
    // x86_64-linux to `localhost` and fork-bombed a production workstation.
    // The correct behavior is a loud refusal, NOT any localhost lane.
    let thrown: Error | undefined;
    try {
      fanoutLanes(empty, [], []);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    // The throw itself is the guarantee (no localhost lane is ever returned);
    // the message must read as a refusal, not the removed "running locally on
    // <system>" graceful-degradation note.
    expect(thrown?.message).not.toMatch(/running locally on/i);
    expect(thrown?.message).toMatch(/refus/i);
  });

  it("names the full resolution chain in the refusal so the operator knows what was checked", () => {
    const msg = messageOf(() => fanoutLanes(empty, [], []));
    expect(msg).toContain("$ODU_HOSTS");
    expect(msg).toContain("~/.config/odu/hosts.json");
    expect(msg).toContain("~/.config/justci/hosts.json");
  });

  it("tells the operator how to opt into localhost on purpose", () => {
    const msg = messageOf(() => fanoutLanes(empty, [], []));
    expect(msg).toContain("--host");
    expect(msg).toContain("localhost");
  });

  it("names the winning-but-empty file when a hosts file exists yet configures nothing", () => {
    // A `{}` file that won resolution still resolves zero lanes → refuse. The
    // diagnosis must name that file, not claim nothing existed.
    const emptyFile = { hosts: {}, source: "/home/me/.config/odu/hosts.json" };
    const msg = messageOf(() => fanoutLanes(emptyFile, [], []));
    expect(msg).toMatch(/refus/i);
    expect(msg).toContain("/home/me/.config/odu/hosts.json");
    expect(msg).toContain("configured no platform");
  });

  it("keeps an explicit --host PLAT=localhost override working (localhost as a decision)", () => {
    expect(fanoutLanes(empty, ["x86_64-linux=localhost"], [])).toEqual({
      "x86_64-linux": "localhost",
    });
  });

  it("keeps an explicit \"PLAT\": \"localhost\" hosts-file entry working", () => {
    const config = {
      hosts: { "x86_64-linux": "localhost" },
      source: "/some/hosts.json",
    };
    expect(fanoutLanes(config, [], [])).toEqual({ "x86_64-linux": "localhost" });
  });

  it("still fans out to a configured remote lane, and missing platforms stay dropped (partial config is a decision)", () => {
    const config = {
      hosts: { "x86_64-linux": "builder.example" },
      source: "/some/hosts.json",
    };
    // aarch64-darwin absent from the config simply doesn't join the fanout —
    // a partial config someone wrote, distinct from the no-config refusal above.
    expect(fanoutLanes(config, [], [])).toEqual({
      "x86_64-linux": "builder.example",
    });
  });
});

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the call to throw");
}
