export { type Gateway, startGateway } from "./versitygw";

/**
 * A `send` WHOSE WINDOW COMES UP SHORT: GETs ranged from byte `from` are
 * answered `206` with their last ten bytes missing, which is what R2 did to a
 * readback in issue #160.
 */
export const shortWindowFrom = (from: number): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(url, init);
    const range = new Headers(init?.headers).get("range");
    if (response.status !== 206 || range?.startsWith(`bytes=${from}-`) !== true) return response;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(bytes.subarray(0, bytes.length - 10), { status: 206, headers });
  }) as typeof fetch;
