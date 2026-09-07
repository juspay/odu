/**
 * WHERE the odu service is, and what it is called there.
 *
 * One fixed default origin, and one env var that moves it. Both halves are
 * here rather than at the three faces that need them, because "the browser and
 * the CLI and the MCP bridge all talk to the same service" is a claim that is
 * only true if they compute the same address — and three copies of a port
 * number is exactly how it stops being true.
 *
 * The port is FIXED and not searched for. A service that fell back to "any
 * free port" would answer the concurrency question by making the address
 * unfindable: a second launcher would bind a second port, both would claim to
 * be the odu service, and a browser tab pointed at the first would be watching
 * a daemon nobody else can reach. The singleton is the point, and a singleton
 * with a variable address is not one. So a fixed port occupied by something
 * that is NOT an odu service is an actionable refusal, never a quiet
 * relocation.
 */

/** The one address `odu web` prints and every face defaults to. 18440 is
 *  outside the ephemeral range on Linux and macOS, so the kernel will not hand
 *  it to an unrelated program's outbound socket while odu is down. */
export const DEFAULT_SERVICE_ORIGIN = "http://127.0.0.1:18440";

/** The env var that moves the whole service — the daemon binds it and every
 *  face dials it, so a developer running a second odu against a scratch
 *  catalog moves both halves with one export. */
export const SERVICE_ORIGIN_ENV = "ODU_WEB_ORIGIN";

/** The app namespace the per-user daemon home is derived from. `web`, not
 *  `odu`: the run catalog already owns `odu` under the state root, and a
 *  daemon home is a different thing living beside it (a gate and a control
 *  socket) rather than a second opinion about where runs go. */
export const SERVICE_APP = "odu-web";

/** The framework's websocket route. Re-exported so a face spells one import
 *  rather than reaching into `@kolu/surface-app` for a constant — the browser
 *  gets it from `connectSurface`'s own default, and this is for the CLI and
 *  the bridge, which have no `location` to derive one from. */
export const SERVICE_WS_PATH = "/rpc/ws";

/** Where MCP-over-HTTP answers. */
export const SERVICE_MCP_PATH = "/mcp";

/** The origin this process should use, from the environment or the default.
 *  Trailing slashes are trimmed so `origin + path` is never `//rpc/ws` — a
 *  path the listener compares for EQUALITY and would silently destroy. */
export function serviceOrigin(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env[SERVICE_ORIGIN_ENV]?.trim();
  const origin = raw === undefined || raw === "" ? DEFAULT_SERVICE_ORIGIN : raw;
  return origin.replace(/\/+$/, "");
}

/** The host and port a listener binds, parsed out of an origin. Returned as a
 *  pair rather than as a URL because `server.listen` takes two arguments and a
 *  caller that re-parsed the string would be the second parser of one fact. */
export function serviceBind(origin: string): { host: string; port: number } {
  const url = new URL(origin);
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  // `hostname` rather than `host`, because the latter carries the port. And the
  // BRACKETS come off: a URL keeps an IPv6 literal bracketed (`[::1]`) because
  // that is how a URL disambiguates it from a port separator, while
  // `server.listen` wants the address itself. Handing `listen` the bracketed
  // form is an `EINVAL` at bind time, on the one address family a developer is
  // least likely to be testing.
  const host = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  return { host, port };
}

/** The websocket URL a non-browser face dials. */
export function serviceWsUrl(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = SERVICE_WS_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** The MCP endpoint an HTTP agent posts to. */
export function serviceMcpUrl(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${SERVICE_MCP_PATH}`;
}
