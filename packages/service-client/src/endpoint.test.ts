/**
 * WHERE the service is — derived once, and identically by every face.
 *
 * The whole value of this module is that the browser, the CLI and the MCP
 * bridge compute the same address. So these tests are about the derivations
 * agreeing, and about the one shape that would silently break the listener: a
 * trailing slash, which `serveSurfaceApp` compares its websocket path for
 * EQUALITY against and would destroy the socket over.
 */

import { describe, expect, it } from "bun:test";
import {
  DEFAULT_SERVICE_ORIGIN,
  SERVICE_WS_PATH,
  serviceBind,
  serviceMcpUrl,
  serviceOrigin,
  serviceWsUrl,
  readPublicOrigin,
} from "./endpoint";

describe("the service origin", () => {
  it("defaults to the one fixed address", () => {
    expect(serviceOrigin({})).toBe(DEFAULT_SERVICE_ORIGIN);
  });

  it("takes the env var when one is set", () => {
    expect(serviceOrigin({ ODU_WEB_ORIGIN: "http://127.0.0.1:9000" })).toBe(
      "http://127.0.0.1:9000",
    );
  });

  it("treats an empty env var as unset rather than as an empty address", () => {
    expect(serviceOrigin({ ODU_WEB_ORIGIN: "   " })).toBe(DEFAULT_SERVICE_ORIGIN);
  });

  it("trims a trailing slash, which the listener would otherwise refuse", () => {
    // `serveSurfaceApp` compares `pathname` for EQUALITY, so a hand-typed
    // trailing slash produces `//rpc/ws` and the upgrade is destroyed.
    expect(serviceWsUrl("http://127.0.0.1:18440/")).toBe(
      `ws://127.0.0.1:18440${SERVICE_WS_PATH}`,
    );
    expect(serviceOrigin({ ODU_WEB_ORIGIN: "http://127.0.0.1:9000//" })).toBe(
      "http://127.0.0.1:9000",
    );
  });
});

describe("derivations from an origin", () => {
  it("binds host and port without the brackets a URL carries", () => {
    expect(serviceBind("http://127.0.0.1:18440")).toEqual({
      host: "127.0.0.1",
      port: 18440,
    });
    // `hostname`, not `host`: an IPv6 literal arrives bracketed and `listen`
    // wants the bare address.
    expect(serviceBind("http://[::1]:18440")).toEqual({ host: "::1", port: 18440 });
  });

  it("upgrades the scheme for the websocket route", () => {
    expect(serviceWsUrl("https://box.example")).toBe("wss://box.example/rpc/ws");
  });

  it("drops a query and fragment the page happened to carry", () => {
    expect(serviceWsUrl("http://127.0.0.1:18440/?a=1#/run/x")).toBe(
      "ws://127.0.0.1:18440/rpc/ws",
    );
  });

  it("names the MCP endpoint on the same origin", () => {
    expect(serviceMcpUrl("http://127.0.0.1:18440")).toBe(
      "http://127.0.0.1:18440/mcp",
    );
  });
});

describe("the origin a bucket is published under", () => {
  it("is absent unless asked for, so a loopback service keeps its own address", () => {
    expect(readPublicOrigin({})).toEqual({ ok: true, origin: null });
    expect(readPublicOrigin({ ODU_PUBLIC_ORIGIN: "  " })).toEqual({ ok: true, origin: null });
  });

  it("takes a scheme, a host and a port — and trims a trailing slash", () => {
    expect(readPublicOrigin({ ODU_PUBLIC_ORIGIN: "https://cache.example.com" })).toEqual({
      ok: true,
      origin: "https://cache.example.com",
    });
    expect(readPublicOrigin({ ODU_PUBLIC_ORIGIN: "https://cache.example.com:8443/" })).toEqual({
      ok: true,
      origin: "https://cache.example.com:8443",
    });
  });

  it("refuses a path, a query or a fragment instead of rewriting it", () => {
    // odu appends `/cache/<bucket>` to whatever this is. A path here would be
    // concatenated into a URL the operator never asked for, and the failure it
    // causes — a substituter that 404s for every client — names nothing.
    for (const value of [
      "https://cache.example.com/nix",
      "https://cache.example.com?x=1",
      "https://cache.example.com#frag",
    ]) {
      const reading = readPublicOrigin({ ODU_PUBLIC_ORIGIN: value });
      expect(reading.ok).toBe(false);
      if (!reading.ok) expect(reading.message).toContain("names more than an origin");
    }
  });

  it("refuses a scheme that is not http or https", () => {
    const reading = readPublicOrigin({ ODU_PUBLIC_ORIGIN: "ftp://cache.example.com" });
    expect(reading.ok).toBe(false);
    if (!reading.ok) expect(reading.message).toContain("is not http or https");
    expect(readPublicOrigin({ ODU_PUBLIC_ORIGIN: "not a url" }).ok).toBe(false);
  });
});
