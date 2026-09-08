/**
 * WHO MAY DRIVE THE SERVICE — the decision both doors share.
 *
 * The case worth stating twice is DNS rebinding, because it is the one where
 * every check that compares the request against ITSELF says yes. The attacker's
 * page is served from `evil.example`, whose DNS has been re-pointed at
 * 127.0.0.1; the browser sends `Origin: http://evil.example:18440` and
 * `Host: evil.example:18440`. Same-origin. Consistent. Entirely somebody else's.
 *
 * The only thing that catches it is a fact the request cannot supply: the set of
 * authorities this listener actually answers to.
 */

import { describe, expect, it } from "bun:test";
import { allowedHostsFor, authorityAllowed, hostIsOurs } from "./webAuthority";

const ORIGIN = "http://127.0.0.1:18440";
const policy = (allowedOrigins: readonly string[] = []) => ({
  allowedOrigins,
  allowedHosts: allowedHostsFor(ORIGIN, allowedOrigins),
});

describe("the authority a request claims", () => {
  it("lets the service's own page in", () => {
    expect(
      authorityAllowed({ origin: ORIGIN, host: "127.0.0.1:18440" }, policy()),
    ).toBe(true);
  });

  it("lets every spelling of loopback in", () => {
    for (const host of ["127.0.0.1:18440", "localhost:18440", "[::1]:18440"]) {
      expect(authorityAllowed({ origin: undefined, host }, policy())).toBe(true);
    }
  });

  it("lets a non-browser client with no Origin in", () => {
    // A CLI, an agent, `curl`. Not the vector, and refusing them would break
    // every non-browser consumer.
    expect(
      authorityAllowed({ origin: undefined, host: "127.0.0.1:18440" }, policy()),
    ).toBe(true);
  });

  it("REFUSES a self-consistent stranger — the rebinding case", () => {
    // Origin matches Host, so the framework's own gate says yes. This is the
    // half it cannot see: neither name is ours.
    expect(
      authorityAllowed(
        {
          origin: "http://untrusted.example:18440",
          host: "untrusted.example:18440",
        },
        policy(),
      ),
    ).toBe(false);
  });

  it("refuses a stranger's Host even with no Origin at all", () => {
    // A non-browser client is allowed past the ORIGIN half, so the Host half
    // has to stand on its own or the exemption becomes the hole.
    expect(
      authorityAllowed({ origin: undefined, host: "untrusted.example" }, policy()),
    ).toBe(false);
  });

  it("refuses a page from elsewhere that reached us at our own name", () => {
    expect(
      authorityAllowed(
        { origin: "https://untrusted.example", host: "127.0.0.1:18440" },
        policy(),
      ),
    ).toBe(false);
  });

  it("refuses a request with no Host to speak of", () => {
    expect(hostIsOurs(undefined, policy())).toBe(false);
    expect(authorityAllowed({ origin: undefined, host: undefined }, policy())).toBe(
      false,
    );
  });

  it("lets an operator name a reverse proxy, and takes its Host with it", () => {
    // The `tailscale serve` case: the browser's origin is the tailnet name and
    // the Host the proxy forwards is that name too. Naming the origin has to
    // name the authority, or the escape hatch is not one.
    const p = policy(["https://box.tailnet.ts.net"]);
    expect(
      authorityAllowed(
        { origin: "https://box.tailnet.ts.net", host: "box.tailnet.ts.net" },
        p,
      ),
    ).toBe(true);
    // And naming one does not open the others.
    expect(
      authorityAllowed(
        { origin: "https://other.tailnet.ts.net", host: "other.tailnet.ts.net" },
        p,
      ),
    ).toBe(false);
  });

  it("answers to nothing when the origin is not an address at all", () => {
    // Failing closed: an unparseable origin names no authority, so nothing is
    // allowed rather than everything.
    expect(allowedHostsFor("not a url")).toEqual([]);
    expect(
      authorityAllowed({ origin: undefined, host: "127.0.0.1:18440" }, {
        allowedOrigins: [],
        allowedHosts: allowedHostsFor("not a url"),
      }),
    ).toBe(false);
  });
});
