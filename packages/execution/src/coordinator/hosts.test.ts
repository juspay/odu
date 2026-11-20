import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { fanoutPools, loadHosts, resolvePools, shortHost } from "./hosts";

const prevOduHosts = process.env.ODU_HOSTS;
afterEach(() => {
  if (prevOduHosts === undefined) delete process.env.ODU_HOSTS;
  else process.env.ODU_HOSTS = prevOduHosts;
});

describe("resolvePools", () => {
  const empty = { hosts: {}, source: null };

  it("returns nothing for a bare run with no config — the fail-fast trigger", () => {
    expect(resolvePools(empty, [], [])).toEqual({});
  });

  it("synthesizes a one-host pool from a --host pin even with no config file", () => {
    expect(resolvePools(empty, ["aarch64-darwin=localhost"], [])).toEqual({
      "aarch64-darwin": ["localhost"],
    });
  });

  it("errors on --platform with no host — operator asked for a pool we can't build", () => {
    expect(() => resolvePools(empty, [], ["x86_64-linux"])).toThrow(
      /no host/,
    );
  });

  it("replaces a multi-host pool with a --host pin (forced pick)", () => {
    const config = {
      hosts: { "x86_64-linux": ["ci-1", "ci-2", "ci-3"] },
      source: "/some/hosts.json",
    };
    expect(
      resolvePools(config, ["x86_64-linux=ci-2"], []),
    ).toEqual({ "x86_64-linux": ["ci-2"] });
  });
});

describe("fanoutPools — the no-config fail-fast (juspay/odu#46)", () => {
  const empty = { hosts: {}, source: null };

  it("REFUSES a bare run with no hosts config — never a silent localhost lane", () => {
    let thrown: Error | undefined;
    try {
      fanoutPools(empty, [], []);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).not.toMatch(/running locally on/i);
    expect(thrown?.message).toMatch(/refus/i);
  });

  it("names the full resolution chain in the refusal so the operator knows what was checked", () => {
    const msg = messageOf(() => fanoutPools(empty, [], []));
    expect(msg).toContain("$ODU_HOSTS");
    expect(msg).toContain("~/.config/odu/hosts.json");
    expect(msg).toContain("~/.config/justci/hosts.json");
  });

  it("tells the operator how to opt into localhost on purpose", () => {
    const msg = messageOf(() => fanoutPools(empty, [], []));
    expect(msg).toContain("--host");
    expect(msg).toContain("localhost");
  });

  it("names the winning-but-empty file when a hosts file exists yet configures nothing", () => {
    const emptyFile = { hosts: {}, source: "/home/me/.config/odu/hosts.json" };
    const msg = messageOf(() => fanoutPools(emptyFile, [], []));
    expect(msg).toMatch(/refus/i);
    expect(msg).toContain("/home/me/.config/odu/hosts.json");
    expect(msg).toContain("configured no platform");
  });

  it("keeps an explicit --host PLAT=localhost override working (localhost as a decision)", () => {
    expect(fanoutPools(empty, ["x86_64-linux=localhost"], []).hosts).toEqual({
      "x86_64-linux": ["localhost"],
    });
  });

  it("keeps an explicit \"PLAT\": \"localhost\" hosts-file entry working", () => {
    const config = {
      hosts: { "x86_64-linux": ["localhost"] },
      source: "/some/hosts.json",
    };
    expect(fanoutPools(config, [], []).hosts).toEqual({
      "x86_64-linux": ["localhost"],
    });
  });

  it("still fans out to a configured remote pool, and missing platforms stay dropped (partial config is a decision)", () => {
    const config = {
      hosts: { "x86_64-linux": ["builder.example"] },
      source: "/some/hosts.json",
    };
    expect(fanoutPools(config, [], []).hosts).toEqual({
      "x86_64-linux": ["builder.example"],
    });
  });

  it("preserves a multi-host pool from the config (juspay/odu#54)", () => {
    const config = {
      hosts: {
        "x86_64-linux": ["ci-1", "ci-2", "ci-3"],
        "aarch64-darwin": ["rasam", "sincereintent"],
      },
      source: "/some/hosts.json",
    };
    expect(fanoutPools(config, [], []).hosts).toEqual({
      "x86_64-linux": ["ci-1", "ci-2", "ci-3"],
      "aarch64-darwin": ["rasam", "sincereintent"],
    });
  });
});

describe("shortHost", () => {
  it("strips user@ and domain for compact pick/status lines", () => {
    expect(shortHost("nix@ci-3")).toBe("ci-3");
    expect(shortHost("nix-infra@rasam.example.ts.net")).toBe("rasam");
    expect(shortHost("srid@sincereintent")).toBe("sincereintent");
    expect(shortHost("localhost")).toBe("localhost");
  });

  it("keeps IPv4 literals intact (no first-dot collapse)", () => {
    expect(shortHost("10.0.0.1")).toBe("10.0.0.1");
    expect(shortHost("10.0.0.2")).toBe("10.0.0.2");
    expect(shortHost("nix@192.168.1.10")).toBe("192.168.1.10");
  });

  it("keeps IPv6 literals intact", () => {
    expect(shortHost("::1")).toBe("::1");
    expect(shortHost("2001:db8::1")).toBe("2001:db8::1");
    expect(shortHost("[2001:db8::1]")).toBe("[2001:db8::1]");
  });

  it("still shortens multi-label DNS names", () => {
    expect(shortHost("builder.lab.example.com")).toBe("builder");
    expect(shortHost("user@ci-3.internal.corp")).toBe("ci-3");
  });
});

function writeHosts(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "odu-hosts-"));
  const path = join(dir, "hosts.json");
  writeFileSync(path, JSON.stringify(body));
  process.env.ODU_HOSTS = path;
  return path;
}

describe("loadHosts — string | list values", () => {
  it("normalizes a plain string to a one-host pool", () => {
    writeHosts({ "x86_64-linux": "builder" });
    expect(loadHosts().hosts).toEqual({ "x86_64-linux": ["builder"] });
  });

  it("keeps a multi-host pool", () => {
    writeHosts({ "x86_64-linux": ["ci-1", "ci-2"] });
    expect(loadHosts().hosts).toEqual({ "x86_64-linux": ["ci-1", "ci-2"] });
  });

  it("refuses an empty pool array", () => {
    writeHosts({ "x86_64-linux": [] });
    expect(() => loadHosts()).toThrow(/must not be empty/);
  });

  it("refuses a non-string pool entry", () => {
    writeHosts({ "x86_64-linux": [1, 2] });
    expect(() => loadHosts()).toThrow(/non-empty strings or.*slots/);
  });

  it("expands declared capacity breadth-first across physical hosts", () => {
    writeHosts({
      "x86_64-linux": [
        { host: "ci-1", slots: 3 },
        { host: "ci-2", slots: 2 },
      ],
    });
    expect(loadHosts().hosts["x86_64-linux"]).toEqual([
      { host: "ci-1", slot: 0, slots: 3 },
      { host: "ci-2", slot: 0, slots: 2 },
      { host: "ci-1", slot: 1, slots: 3 },
      { host: "ci-2", slot: 1, slots: 2 },
      { host: "ci-1", slot: 2, slots: 3 },
    ]);
  });

  it("refuses zero, fractional, and malformed slot counts", () => {
    for (const slots of [0, 1.5, "2"]) {
      writeHosts({ "x86_64-linux": { host: "ci-1", slots } });
      expect(() => loadHosts()).toThrow(/positive integer/);
    }
  });

  it("parses a mixed pool — locality is judged per run, not per file (juspay/odu#66)", () => {
    writeHosts({ "x86_64-linux": ["ci-1", "localhost", "ci-2"] });
    expect(loadHosts().hosts).toEqual({
      "x86_64-linux": ["ci-1", "localhost", "ci-2"],
    });
  });

  it("keeps a pure-local sole-localhost pool", () => {
    writeHosts({ "x86_64-linux": ["localhost"] });
    expect(loadHosts().hosts).toEqual({ "x86_64-linux": ["localhost"] });
  });
});

describe("pool locality is judged over what a run resolves (juspay/odu#66)", () => {
  it("lets a darwin-only pinned run through past a mixed linux pool it never touches", () => {
    writeHosts({
      "x86_64-linux": ["ci-1", "localhost", "ci-2"],
      "aarch64-darwin": ["rasam"],
    });
    const config = loadHosts();
    expect(
      fanoutPools(config, ["aarch64-darwin=sincereintent"], ["aarch64-darwin"])
        .hosts,
    ).toEqual({ "aarch64-darwin": ["sincereintent"] });
  });

  it("resolves a mixed pool without judging it — the lease seam owns that rule", () => {
    writeHosts({ "x86_64-linux": ["ci-1", "localhost", "ci-2"] });
    const config = loadHosts();
    expect(fanoutPools(config, [], []).hosts).toEqual({
      "x86_64-linux": ["ci-1", "localhost", "ci-2"],
    });
  });

  it("lets a pin stand alone — it replaces the file's mixed pool, so nothing mixed resolves", () => {
    writeHosts({ "x86_64-linux": ["ci-1", "localhost", "ci-2"] });
    const config = loadHosts();
    expect(fanoutPools(config, ["x86_64-linux=ci-9"], []).hosts).toEqual({
      "x86_64-linux": ["ci-9"],
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
