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
