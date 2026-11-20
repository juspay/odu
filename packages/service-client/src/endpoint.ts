/** The one address `odu web` prints and every face defaults to. 18440 is
 *  outside the ephemeral range on Linux and macOS, so the kernel will not hand
 *  it to an unrelated program's outbound socket while odu is down. */
export const DEFAULT_SERVICE_ORIGIN = "http://127.0.0.1:18440";

export const SERVICE_ORIGIN_ENV = "ODU_WEB_ORIGIN";

export const SERVICE_APP = "odu-web";

export const SERVICE_WS_PATH = "/rpc/ws";

export const SERVICE_MCP_PATH = "/mcp";

function withoutTrailingSlashes(origin: string): string {
  let end = origin.length;
  while (end > 0 && origin.charCodeAt(end - 1) === 47) end -= 1;
  return origin.slice(0, end);
}

/** THE ORIGIN THE ENVIRONMENT NAMES, or `undefined` when it names none. */
export function namedOrigin(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env[SERVICE_ORIGIN_ENV]?.trim();
  return raw === undefined || raw === "" ? undefined : withoutTrailingSlashes(raw);
}

/** The origin this process should use, from the environment or the default.
 *  Trailing slashes are trimmed. */
export function serviceOrigin(
  env: Record<string, string | undefined> = process.env,
): string {
  return namedOrigin(env) ?? DEFAULT_SERVICE_ORIGIN;
}

/** The env var naming the address a BUCKET is reachable at from outside, when
 *  that is not the address this process binds. */
export const PUBLIC_ORIGIN_ENV = "ODU_PUBLIC_ORIGIN";

/** What `$ODU_PUBLIC_ORIGIN` came to: absent, an origin, or the reason it is
 *  not one. */
export type PublicOriginReading =
  | { ok: true; origin: string | null }
  | { ok: false; message: string };

/**
 * The origin a bucket's substituter URL is published under, or the reason the
 * setting is unusable.
 *
 * It is an ORIGIN and nothing else: `<scheme>://<host>[:port]`; a path, a
 * query or a fragment is a refusal rather than a rewrite.
 */
export function readPublicOrigin(
  env: Record<string, string | undefined> = process.env,
): PublicOriginReading {
  const raw = env[PUBLIC_ORIGIN_ENV]?.trim();
  if (raw === undefined || raw === "") return { ok: true, origin: null };
  let url: URL;
  try {
    url = new URL(withoutTrailingSlashes(raw));
  } catch {
    return { ok: false, message: `$${PUBLIC_ORIGIN_ENV}=${raw} is not a URL` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      message: `$${PUBLIC_ORIGIN_ENV}=${raw} is not http or https`,
    };
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return {
      ok: false,
      message:
        `$${PUBLIC_ORIGIN_ENV}=${raw} names more than an origin — scheme, host ` +
        "and port only, because odu appends the bucket's own path to it",
    };
  }
  return { ok: true, origin: `${url.protocol}//${url.host}` };
}

/** The host and port a listener binds, parsed out of an origin. */
export function serviceBind(origin: string): { host: string; port: number } {
  const url = new URL(origin);
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  const host = url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
  return { host, port };
}

export function serviceWsUrl(origin: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = SERVICE_WS_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function serviceMcpUrl(origin: string): string {
  return `${withoutTrailingSlashes(origin)}${SERVICE_MCP_PATH}`;
}
