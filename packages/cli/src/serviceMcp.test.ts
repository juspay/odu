/**
 * The second door — `/mcp`'s gate, and the id bookkeeping behind it.
 *
 * `serveSurfaceApp` gates the websocket upgrade on `Origin` and nothing else,
 * because `@kolu/surface` was written when the upgrade was the only door.
 * Mounting an HTTP route beside it opened a second one, and a cross-site page
 * does not have to READ a reply to cause the mutation — so these tests are
 * about what must never get through, stated as a table of worlds rather than as
 * a claim in a comment.
 *
 * The other half is correlation. One `Server` behind one endpoint serves every
 * caller, they all start their JSON-RPC ids at 1, and a cancellation names one
 * of those ids. Getting that wrong does not fail loudly: it cancels somebody
 * else's run wait.
 */

import { describe, expect, it } from "bun:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  allowedHostsFor,
  gateMcpRequest,
  RouteTransport,
} from "./serviceMcp";

const ORIGIN = "http://127.0.0.1:18440";
const HOSTS = allowedHostsFor(ORIGIN);

const headers = (over: Record<string, string | undefined> = {}) => ({
  "content-type": "application/json",
  host: "127.0.0.1:18440",
  ...over,
});

describe("what may POST to /mcp", () => {
  it("lets the browser this service serves talk to it", () => {
    expect(
      gateMcpRequest(headers({ origin: ORIGIN }), {
        allowedOrigins: [],
        allowedHosts: HOSTS,
      }).ok,
    ).toBe(true);
  });

  it("lets a non-browser client with no Origin talk to it", () => {
    // A CLI, an agent, `curl`. They are not the CSWSH vector, and refusing them
    // would break every non-browser consumer — which is why the content-type
    // check has to carry the weight instead.
    expect(gateMcpRequest(headers(), { allowedOrigins: [], allowedHosts: HOSTS }).ok).toBe(
      true,
    );
  });

  it("refuses a page from somewhere else — the mutation IS the attack", () => {
    // The reproduction from review: a POST carrying `run_cancel` with a hostile
    // Origin used to reach domain dispatch and answer 200.
    const verdict = gateMcpRequest(
      headers({ origin: "https://untrusted.example" }),
      { allowedOrigins: [], allowedHosts: HOSTS },
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.status).toBe(403);
  });

  it("refuses a Host this service does not answer to", () => {
    // DNS rebinding: the attacker's domain resolves to 127.0.0.1, so Origin and
    // Host are BOTH theirs and match each other. Only naming the authorities
    // this listener actually has catches it.
    const verdict = gateMcpRequest(
      headers({ origin: "https://untrusted.example", host: "untrusted.example" }),
      { allowedOrigins: [], allowedHosts: HOSTS },
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.status).toBe(421);
  });

  it("refuses the content types a form can post without a preflight", () => {
    // `text/plain`, `multipart/form-data` and `application/x-www-form-urlencoded`
    // are the three a cross-origin form sends with no CORS preflight and no
    // Origin rules to lean on. Requiring JSON is what forces the preflight this
    // endpoint never answers.
    for (const type of [
      "text/plain",
      "multipart/form-data; boundary=x",
      "application/x-www-form-urlencoded",
      undefined,
    ]) {
      const verdict = gateMcpRequest(headers({ "content-type": type }), {
        allowedOrigins: [],
        allowedHosts: HOSTS,
      });
      expect(verdict.ok).toBe(false);
      if (verdict.ok) continue;
      expect(verdict.status).toBe(415);
    }
  });

  it("accepts JSON with a charset, because that is what clients send", () => {
    expect(
      gateMcpRequest(headers({ "content-type": "application/json; charset=utf-8" }), {
        allowedOrigins: [],
        allowedHosts: HOSTS,
      }).ok,
    ).toBe(true);
  });

  it("lets an operator name an origin, and takes its host with it", () => {
    const allowedOrigins = ["https://box.tailnet.ts.net"];
    const hosts = allowedHostsFor(ORIGIN, allowedOrigins);
    expect(
      gateMcpRequest(
        headers({ origin: "https://box.tailnet.ts.net", host: "box.tailnet.ts.net" }),
        { allowedOrigins, allowedHosts: hosts },
      ).ok,
    ).toBe(true);
  });

  it("answers to every spelling of loopback", () => {
    // A browser sends `localhost:18440`, `curl` sends `127.0.0.1:18440`, an
    // IPv6 client sends `[::1]:18440`. All three are this service.
    expect(HOSTS).toContain("127.0.0.1:18440");
    expect(HOSTS).toContain("localhost:18440");
    expect(HOSTS).toContain("[::1]:18440");
  });
});

/** A transport wired to a server that answers whatever it is asked, on demand. */
function wired(): {
  transport: RouteTransport;
  seen: JSONRPCMessage[];
  answer: (mintedId: string, result: unknown) => void;
} {
  const transport = new RouteTransport();
  const seen: JSONRPCMessage[] = [];
  transport.onmessage = (message) => {
    seen.push(message);
  };
  return {
    transport,
    seen,
    answer: (mintedId, result) => {
      void transport.send({ jsonrpc: "2.0", id: mintedId, result } as JSONRPCMessage);
    },
  };
}

/** The id this transport minted for the nth request it received. */
function mintedIds(seen: JSONRPCMessage[]): string[] {
  return seen
    .map((m) => (m as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string");
}

describe("two callers, one endpoint", () => {
  it("gives each its own reply, wearing its own id", async () => {
    // Both clients start at id 1. Keyed on the caller's id, the second would be
    // told "already in flight" — or handed the first one's answer.
    const { transport, seen, answer } = wired();
    const a = transport.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      session: "A",
    });
    const b = transport.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      session: "B",
    });
    const [first, second] = mintedIds(seen);
    expect(first).not.toBe(second);
    answer(second as string, { who: "B" });
    answer(first as string, { who: "A" });
    expect(await a).toEqual({ jsonrpc: "2.0", id: 1, result: { who: "A" } });
    expect(await b).toEqual({ jsonrpc: "2.0", id: 1, result: { who: "B" } });
  });

  it("cancels only the session that asked", async () => {
    const { transport, seen, answer } = wired();
    const a = transport.ask({ jsonrpc: "2.0", id: 7, method: "tools/call" }, {
      session: "A",
    });
    const b = transport.ask({ jsonrpc: "2.0", id: 7, method: "tools/call" }, {
      session: "B",
    });
    const [mintedA, mintedB] = mintedIds(seen);

    await transport.ask(
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 7, reason: "user" },
      },
      { session: "A" },
    );
    // The server is told to cancel A's call, named by the id IT was given —
    // which is the whole point: `7` means nothing to the SDK, which saw
    // `odu-1`.
    const cancelled = seen.filter(
      (m) => (m as { method?: unknown }).method === "notifications/cancelled",
    );
    expect(cancelled).toHaveLength(1);
    expect(
      (cancelled[0] as unknown as { params: { requestId: string } }).params.requestId,
    ).toBe(mintedA as string);
    expect(await a).toBeNull();

    // B is untouched and still answerable.
    answer(mintedB as string, { who: "B" });
    expect(await b).toEqual({ jsonrpc: "2.0", id: 7, result: { who: "B" } });
  });

  it("DROPS a cancellation from a client that echoed no session", async () => {
    // Without a session there is no way to tell whose `7` this is. Applying it
    // to the most recent one would let any client cancel any other's call.
    const { transport, seen, answer } = wired();
    const a = transport.ask({ jsonrpc: "2.0", id: 7, method: "tools/call" }, {
      session: "A",
    });
    await transport.ask({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7 },
    });
    expect(
      seen.filter((m) => (m as { method?: unknown }).method === "notifications/cancelled"),
    ).toHaveLength(0);

    const [minted] = mintedIds(seen);
    answer(minted as string, { still: "here" });
    expect(await a).toEqual({ jsonrpc: "2.0", id: 7, result: { still: "here" } });
  });

  it("releases a call whose HTTP request went away, and says so upstream", async () => {
    // The disconnect case. The POST is answered, the SDK is told the request is
    // cancelled — which is what interrupts the fiber, because every MCP request
    // runs under its own signal — and the RUN is untouched.
    const { transport, seen } = wired();
    const withdraw = new AbortController();
    const call = transport.ask({ jsonrpc: "2.0", id: 1, method: "tools/call" }, {
      session: "A",
      signal: withdraw.signal,
    });
    withdraw.abort();
    expect(await call).toBeNull();
    const cancelled = seen.filter(
      (m) => (m as { method?: unknown }).method === "notifications/cancelled",
    );
    expect(cancelled).toHaveLength(1);
    expect(
      (cancelled[0] as unknown as { params: { reason: string } }).params.reason,
    ).toContain("disconnected");
  });

  it("releases every waiter when the transport closes", async () => {
    const { transport } = wired();
    const call = transport.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {
      session: "A",
    });
    await transport.close();
    // A POST left hanging on a closed transport is a client that waits for
    // ever, which is worse than a null it can retry.
    expect(await call).toBeNull();
  });
});
