import { describe, expect, it } from "bun:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { gateMcpRequest, RouteTransport } from "./mcpRoute";

const ORIGIN = "http://127.0.0.1:18440";

const headers = (over: Record<string, string | undefined> = {}) => ({
  "content-type": "application/json",
  host: "127.0.0.1:18440",
  ...over,
});

describe("what may POST to /mcp", () => {
  it("lets the browser this service serves talk to it", () => {
    expect(gateMcpRequest(headers({ origin: ORIGIN }), []).ok).toBe(true);
  });

  it("lets a non-browser client with no Origin talk to it", () => {
    expect(gateMcpRequest(headers(), []).ok).toBe(true);
  });

  it("refuses a page from somewhere else — the mutation IS the attack", () => {
    const verdict = gateMcpRequest(
      headers({ origin: "https://untrusted.example" }),
      [],
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.status).toBe(403);
  });

  it("answers to whatever name it was reached by", () => {
    for (const host of [
      "pureintent.rooster-blues.ts.net:18440",
      "localhost:18440",
      "[::1]:18440",
    ]) {
      expect(
        gateMcpRequest(headers({ origin: `http://${host}`, host }), []).ok,
      ).toBe(true);
      expect(gateMcpRequest(headers({ host }), []).ok).toBe(true);
    }
  });

  it("refuses the content types a form can post without a preflight", () => {
    for (const type of [
      "text/plain",
      "multipart/form-data; boundary=x",
      "application/x-www-form-urlencoded",
      undefined,
    ]) {
      const verdict = gateMcpRequest(headers({ "content-type": type }), []);
      expect(verdict.ok).toBe(false);
      if (verdict.ok) continue;
      expect(verdict.status).toBe(415);
    }
  });

  it("accepts JSON with a charset, because that is what clients send", () => {
    expect(
      gateMcpRequest(
        headers({ "content-type": "application/json; charset=utf-8" }),
        [],
      ).ok,
    ).toBe(true);
  });

  it("lets an operator name an origin that differs from the Host", () => {
    const allowed = ["https://box.tailnet.ts.net"];
    const proxied = headers({ origin: "https://box.tailnet.ts.net" });
    expect(gateMcpRequest(proxied, allowed).ok).toBe(true);
    expect(gateMcpRequest(proxied, []).ok).toBe(false);
  });
});

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

function mintedIds(seen: JSONRPCMessage[]): string[] {
  return seen
    .map((m) => (m as { id?: unknown }).id)
    .filter((id): id is string => typeof id === "string");
}

describe("two callers, one endpoint", () => {
  it("gives each its own reply, wearing its own id", async () => {
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
    const cancelled = seen.filter(
      (m) => (m as { method?: unknown }).method === "notifications/cancelled",
    );
    expect(cancelled).toHaveLength(1);
    expect(
      (cancelled[0] as unknown as { params: { requestId: string } }).params.requestId,
    ).toBe(mintedA as string);
    expect(await a).toBeNull();

    answer(mintedB as string, { who: "B" });
    expect(await b).toEqual({ jsonrpc: "2.0", id: 7, result: { who: "B" } });
  });

  it("DROPS a cancellation from a client that echoed no session", async () => {
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
    expect(await call).toBeNull();
  });
});
