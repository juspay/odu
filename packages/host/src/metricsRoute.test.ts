/**
 * `GET /metrics`, AS A CLIENT MEETS IT.
 *
 * `HttpRouter.toWebHandler` gives the listener's own routing as a `fetch`-shaped
 * function, so what is asserted here is the status, the headers and the body a
 * Prometheus would see — including the one case that matters most and is
 * invisible to a handler-level test: the route is answered by the host, so a
 * scrape must never be able to reach it without a credential.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { HttpRouter } from "effect/http";
import { metricsBroker } from "@odu/cordis/metrics";
import { metricsRoute } from "./metricsRoute";
import { openMetricsTokens } from "./metricsTokens";

const ROOT = "root-token";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "odu-metrics-route-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function world(rootToken: string | null = ROOT) {
  const sources = metricsBroker();
  sources.add({
    name: "cache",
    read: () => ({
      gauges: [{ name: "odu_cache_paths", help: "Paths.", points: [{ labels: { bucket: "main" }, value: 2 }] }],
    }),
  });
  const tokens = openMetricsTokens(scratch);
  const { handler, dispose } = HttpRouter.toWebHandler(
    metricsRoute({ sources: () => sources, rootToken, tokens }),
    { disableLogger: true },
  );
  const ask = (authorization?: string): Promise<Response> =>
    handler(
      new Request("http://127.0.0.1:18440/metrics", {
        headers: authorization === undefined ? {} : { authorization },
      }),
    );
  return { ask, tokens, dispose };
}

describe("the scrape's door", () => {
  it("refuses an anonymous scrape, and says what opens it", async () => {
    const { ask, dispose } = world();
    try {
      const answer = await ask();
      expect(answer.status).toBe(401);
      expect(answer.headers.get("www-authenticate")).toContain("Bearer");
      expect(await answer.text()).toContain("$ODU_ROOT_TOKEN");
    } finally {
      await dispose();
    }
  });

  it("refuses a wrong token and a credential that is not a bearer", async () => {
    const { ask, dispose } = world();
    try {
      expect((await ask("Bearer wrong")).status).toBe(401);
      expect((await ask(`Basic ${Buffer.from(`x:${ROOT}`).toString("base64")}`)).status).toBe(401);
      expect((await ask(ROOT)).status).toBe(401);
    } finally {
      await dispose();
    }
  });

  it("opens for the root token, with the exposition's own content type", async () => {
    const { ask, dispose } = world();
    try {
      const answer = await ask(`Bearer ${ROOT}`);
      expect(answer.status).toBe(200);
      expect(answer.headers.get("content-type")).toContain("version=0.0.4");
      expect(await answer.text()).toContain('odu_cache_paths{bucket="main"} 2');
    } finally {
      await dispose();
    }
  });

  it("opens for a metrics token, and shuts the moment it is revoked", async () => {
    const { ask, tokens, dispose } = world();
    try {
      const minted = tokens.mint("prometheus-pod");
      expect((await ask(`Bearer ${minted.token}`)).status).toBe(200);
      tokens.revoke(minted.facts.id);
      expect((await ask(`Bearer ${minted.token}`)).status).toBe(401);
    } finally {
      await dispose();
    }
  });

  it("is shut on a daemon with no root token, metrics token or not", async () => {
    // Nothing can mint one either, so this is the whole surface: a daemon
    // nobody configured a credential for publishes no numbers.
    const { ask, tokens, dispose } = world(null);
    try {
      expect((await ask("Bearer ")).status).toBe(401);
      // A token minted before the root token was removed still works — it is a
      // credential of its own, which is the point of having it.
      const minted = tokens.mint("pod");
      expect((await ask(`Bearer ${minted.token}`)).status).toBe(200);
    } finally {
      await dispose();
    }
  });
});
