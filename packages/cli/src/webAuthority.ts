/**
 * WHO MAY DRIVE THIS SERVICE — one decision, both doors.
 *
 * The web service binds loopback and answers two kinds of client: a websocket
 * at `/rpc/ws` and JSON-RPC at `/mcp`. Both reach the same surface, so both can
 * start a run, retry one and cancel one. There is therefore exactly one
 * question to answer about an incoming request, and it must be answered the
 * same way at both doors or the weaker one is the only one that matters.
 *
 * ## The question is about the AUTHORITY, not only the Origin
 *
 * `@kolu/surface`'s `isAllowedWsOrigin` is the CSWSH gate, and it is right
 * about what it does: a page from somewhere else carries an `Origin` that does
 * not match the `Host` it reached, and is refused. What it cannot see is that
 * the `Host` itself is a lie.
 *
 * DNS rebinding is that attack. A page served from `evil.example` — whose DNS
 * has been re-pointed at `127.0.0.1` — opens `ws://evil.example:18440/rpc/ws`.
 * The browser sends `Origin: http://evil.example:18440` and
 * `Host: evil.example:18440`. They MATCH, because they are both the attacker's,
 * so a same-origin comparison says yes. The missing half is the listener's own
 * answer: *this service is not reachable at that name*.
 *
 * So an odu request is allowed when BOTH hold:
 *
 *   1. the `Host` is an authority this listener actually answers to, and
 *   2. the `Origin` is absent (a non-browser client, which is not the thing
 *      being defended against), same-origin, or explicitly allowed by the
 *      operator.
 *
 * The second half is the framework's own function rather than a copy of it, so
 * the two gates cannot drift apart on the part they share.
 *
 * ## Where each door applies it
 *
 * `/mcp` applies it before dispatch, in `./serviceMcp`, and answers 421 or 403.
 *
 * The websocket applies it at the earliest point odu can reach: the
 * per-connection service layer, which `serveSurfaceApp` builds before the RPC
 * server for that socket exists. A refused connection therefore never gets a
 * serving stack, never reads a frame, and can call nothing. It is one step
 * later than the framework's own raw-socket refusal — the upgrade handler
 * belongs to `serveSurfaceApp` and takes no hook — so the TCP handshake does
 * complete. That is stated here rather than hidden, and it is what a test in
 * `../../tests/e2e/web.e2e.test.ts` pins: the socket opens and answers nothing.
 */

import { isAllowedWsOrigin } from "@kolu/surface/ws-origin";

/** The deployment policy both doors are gated by. */
export interface WebAuthority {
  /** Browser origins allowed beyond same-origin — the operator's
   *  `ODU_WEB_ALLOWED_ORIGINS`, parsed once. */
  allowedOrigins: readonly string[];
  /** `host:port` authorities this listener answers to. */
  allowedHosts: readonly string[];
}

/** The two headers the decision reads, however a door happens to spell them. */
export interface RequestAuthority {
  origin: string | undefined;
  host: string | undefined;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0.0.0.0"]);

/**
 * The `Host` authorities a service bound at `origin` answers to.
 *
 * A loopback bind answers to every spelling of loopback, and a browser, a
 * `curl` and an agent will each pick a different one — so all three are here
 * rather than only the one that happens to be in the env var. Anything else has
 * to be named by the operator, which is what makes a `Host` from somebody
 * else's domain a refusal instead of a request.
 */
export function allowedHostsFor(
  origin: string,
  allowedOrigins: readonly string[] = [],
): string[] {
  const hosts = new Set<string>();
  try {
    const url = new URL(origin);
    hosts.add(url.host);
    if (LOOPBACK.has(url.hostname)) {
      const port = url.port === "" ? "" : `:${url.port}`;
      for (const name of ["127.0.0.1", "localhost", "[::1]"]) {
        hosts.add(`${name}${port}`);
      }
    }
  } catch {
    // An origin that is not a URL names no authority, so the gate refuses
    // everything — which is the right direction to fail.
  }
  for (const allowed of allowedOrigins) {
    try {
      hosts.add(new URL(allowed).host);
    } catch {
      // Not a URL. The Origin half refuses it on its own.
    }
  }
  return [...hosts];
}

/** Is this `Host` one this listener actually has? */
export function hostIsOurs(
  host: string | undefined,
  policy: WebAuthority,
): boolean {
  return host !== undefined && policy.allowedHosts.includes(host);
}

/** The whole decision. See the module header for why it is two halves. */
export function authorityAllowed(
  request: RequestAuthority,
  policy: WebAuthority,
): boolean {
  if (!hostIsOurs(request.host, policy)) return false;
  return isAllowedWsOrigin({
    origin: request.origin,
    host: request.host,
    allowedOrigins: policy.allowedOrigins,
  });
}
