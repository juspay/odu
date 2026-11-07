/**
 * `@odu/objects/testing` — what a consumer's suite needs to run its own cases
 * against a real S3 service: the versitygw gateway, and a `send` that makes
 * that service lie the one way a window read cannot survive. Test-only;
 * nothing the package ships imports it.
 */
export { type Gateway, startGateway } from "./versitygw";

/**
 * A `send` WHOSE WINDOW COMES UP SHORT: GETs ranged from byte `from` are
 * answered `206` with their last ten bytes missing, which is what R2 did to a
 * readback in issue #160.
 *
 * It lives here rather than in each suite because what it encodes is this
 * package's own wire — that windows are asked for as `bytes=<from>-`, that
 * they come back `206`, and that `content-length` is the header a short body
 * contradicts. A consumer proving what its READER does with a short window
 * should not have to hold a second opinion about any of that.
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
