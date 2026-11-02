/**
 * THE PUSH CLIENT — `odu cache push`, and the one command that is not a client
 * of the odu service.
 *
 * Every other public command asks the shared daemon. This one cannot, and the
 * reason is physical rather than architectural: the paths live on the machine
 * that built them, so the bytes have to leave from here. It is a client of the
 * cache's HTTP API instead, with a token — which imports none of the roots
 * `packages/cli/src/authority.test.ts` forbids, so it is admissible there for
 * the reason that test's header states.
 *
 * **What it does that `nix copy` does not.** Three things, and they are the
 * whole reason it exists (see the comparison table on the docs page): one
 * BATCHED `missing` query instead of a probe per path; four uploads in flight;
 * and a per-path retry. It also uploads only what the bucket will actually
 * take — the server drops paths signed by an upstream key, so a nixpkgs
 * dependency never costs an upload.
 *
 * **Uploads go in dependency order.** The cache records each narinfo; a
 * reference is a NAME, not a path the server must already hold, so ordering is
 * about a consumer walking the closure rather than an import. Paths go
 * shallowest first; concurrency is applied WITHIN a depth, never across one.
 *
 * **A NAR is never in memory.** Each upload is `nix store dump-path | zstd -T0
 * -c` piped straight into the request body, which is why this can push a
 * multi-gigabyte closure on a laptop.
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  credentialsPath as sharedCredentialsPath,
  normalizeOrigin,
  readCredentials as sharedReadCredentials,
  saveCredential as sharedSaveCredential,
} from "@odu/credentials";
import {
  isDerivationPath,
  narHashBase32,
  storePathBasename,
  storePathHash,
} from "./narinfo";
import { CACHE_MOUNT, PARTS_HEADER, UPLOAD_SESSION_HEADER } from "./paths";
import { DEFAULT_NAR_PART_BYTES, MAX_NAR_PART_BYTES } from "./surface";
import { type PathInfo, nixClosure, nixDump } from "./store";

/** The environment slice this client reads. Passed in rather than reached for:
 *  the package reads no environment of its own. */
export interface PushEnv {
  readonly ODU_CACHE_TOKEN?: string | undefined;
  readonly ODU_WEB_ORIGIN?: string | undefined;
  readonly HOME?: string | undefined;
  readonly XDG_CONFIG_HOME?: string | undefined;
  /** The index signature is what makes `process.env` assignable here — named
   *  fields alone are structurally incompatible with `ProcessEnv`, and the
   *  alternative is a cast at every call site. */
  readonly [other: string]: string | undefined;
}

/** THIS ROW'S STORE — the one word that differs from the auth row's file. */
const STORE = "cache";

/** Where a logged-in token lives: one entry per origin, 0600, under the user's
 *  config directory (see `@odu/credentials`). */
export const credentialsPath = (env: PushEnv): string => sharedCredentialsPath(env, STORE);

const readCredentials = (env: PushEnv): Promise<Record<string, string>> =>
  sharedReadCredentials(env, STORE);

/** Save a token for an origin. Answers the path it wrote, for the message the
 *  command prints. */
export const saveCredential = (env: PushEnv, origin: string, token: string): Promise<string> =>
  sharedSaveCredential(env, STORE, origin, token);

/** `http://127.0.0.1:18440/` → `http://127.0.0.1:18440`, so a token saved by one
 *  spelling is found by the other. */
export { normalizeOrigin } from "@odu/credentials";

export interface ResolvedBucket {
  origin: string;
  name: string;
}

/**
 * What the bucket argument meant: a full URL names its own origin, and a bare
 * name is resolved against the origin this machine has logged in to — or, when
 * it has logged in to none, `$ODU_WEB_ORIGIN` (which is how the loopback
 * service is addressed).
 */
export async function resolveBucket(
  env: PushEnv,
  argument: string,
  /** `--origin`, which BEATS everything stored. A machine logged in to one
   *  cache must still be able to push to a second without logging out of the
   *  first, so the explicit flag is the first answer and not the last. */
  explicitOrigin?: string,
): Promise<ResolvedBucket | { error: string }> {
  if (/^https?:\/\//i.test(argument)) {
    const url = new URL(argument);
    const name = url.pathname.split("/").filter((part) => part !== "").pop() ?? "";
    if (name === "") return { error: `${argument} names no bucket` };
    return { origin: normalizeOrigin(`${url.protocol}//${url.host}`), name };
  }
  if (explicitOrigin !== undefined && explicitOrigin.trim() !== "") {
    return { origin: normalizeOrigin(explicitOrigin.trim()), name: argument };
  }
  const loggedIn = Object.keys(await readCredentials(env));
  if (loggedIn.length === 1) {
    return { origin: normalizeOrigin(loggedIn[0] as string), name: argument };
  }
  if (loggedIn.length > 1) {
    return {
      error:
        `this machine is logged in to ${loggedIn.length} cache origins, so ` +
        `"${argument}" is ambiguous — name the bucket by URL instead`,
    };
  }
  const origin = env.ODU_WEB_ORIGIN?.trim();
  return {
    origin: normalizeOrigin(
      origin !== undefined && origin !== "" ? origin : "http://127.0.0.1:18440",
    ),
    name: argument,
  };
}

/** The token, in the order the docs promise: `--token-file`, then
 *  `$ODU_CACHE_TOKEN`, then the credentials entry for the bucket's origin. */
export async function resolveToken(
  env: PushEnv,
  origin: string,
  tokenFile: string | undefined,
): Promise<string | null> {
  if (tokenFile !== undefined) {
    return (await readFile(tokenFile, "utf8")).trim();
  }
  const fromEnv = env.ODU_CACHE_TOKEN?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const entries = await readCredentials(env);
  return entries[normalizeOrigin(origin)] ?? null;
}

/** The closure this client uploads. Named for what the caller means; the shape
 *  is the store's, and the parser behind it is the store's too — one answer to
 *  "what did `nix path-info` say", for the pusher and for a pin. */
export type ClosureEntry = PathInfo;

export interface PushSummary {
  pushed: number;
  /** Paths the bucket already has, or would not take because an upstream key
   *  signed them. The server says which is which. */
  skippedUpstream: number;
  /** Derivations the caller named. A cache serves outputs; a `.drv` is a
   *  recipe, and its references are recipes. */
  skippedDerivation: readonly string[];
  alreadyPresent: number;
  failed: number;
  /** One line per failure, for a caller that wants to say which paths did not
   *  make it. */
  failures: readonly { path: string; message: string }[];
  /** The daemon that answered, for a refusal's follow-up. */
  pageUrl: string;
}

/**
 * The two things this client needs from the machine it runs on, behind one
 * seam. `nix path-info -r` answers the closure and `nix store dump-path` the
 * bytes; the suite supplies both so that ordering, retries and token
 * precedence are asserted without a store — the same seam the rest of the tree
 * gives `gh` and the clock.
 */
export interface PushPlatform {
  closure(paths: readonly string[]): Promise<PathInfo[]>;
  dump(storePath: string): ReadableStream<Uint8Array>;
}

export interface PushOptions {
  /** A bucket name or a full URL. */
  bucket: string;
  /** Installables or store paths, as `nix path-info` takes them. */
  paths: readonly string[];
  env: PushEnv;
  /** `--origin`, which beats a stored credential. */
  origin?: string;
  tokenFile?: string;
  /** Uploads in flight WITHIN one dependency depth. */
  concurrency?: number;
  /**
   * HOW LARGE ONE REQUEST MAY BE. A NAR bigger than this is sent in parts, each
   * retried on its own. The default is under Cloudflare's 100 MB proxied-body
   * cap; the server's ceiling is {@link MAX_NAR_PART_BYTES}.
   */
  partSize?: number;
  /** Attempts per path. */
  attempts?: number;
  onLine?: (line: string) => void;
  platform?: PushPlatform;
}

/** How many uploads run at once by default. Four saturates a home uplink
 *  without turning a push into a burst of parallel `nix store dump-path`s on a
 *  laptop that is also building. */
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_ATTEMPTS = 3;

/** Which answers are worth another attempt. A 4xx is the REQUEST being wrong —
 *  a bad token, a bad narinfo — and repeating it streams the whole NAR again
 *  for the same answer. */
function worthRetrying(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function pushToCache(options: PushOptions): Promise<PushSummary> {
  const say = options.onLine ?? (() => {});
  const resolved = await resolveBucket(options.env, options.bucket, options.origin);
  if ("error" in resolved) throw new Error(resolved.error);
  const token = await resolveToken(options.env, resolved.origin, options.tokenFile);
  if (token === null) {
    throw new Error(
      `no token for ${resolved.origin} — pass --token-file, set $ODU_CACHE_TOKEN, ` +
        `or run \`odu cache login ${resolved.origin}\``,
    );
  }
  const base = `${resolved.origin}${CACHE_MOUNT}/${resolved.name}`;
  const headers = { authorization: `Bearer ${token}` };

  const platform: PushPlatform = options.platform ?? {
    closure: (paths) => nixClosure(paths, null),
    dump: (storePath) => nixDump(storePath, null),
  };
  // A DERIVATION IS NOT A CACHE OBJECT. Its references are recipes, and
  // fetching one lets Nix try to BUILD it on the cache host. Report and skip;
  // the exit stays 0, like an upstream-signed path.
  const skippedDerivation = options.paths.filter(isDerivationPath);
  for (const path of skippedDerivation) say(`⏭ ${path} skipped-derivation`);
  const uploadable = options.paths.filter((path) => !isDerivationPath(path));
  const closure =
    uploadable.length === 0
      ? new Map()
      : new Map((await platform.closure(uploadable)).map((info) => [info.storePath, info]));
  // An empty closure has nothing to ask; the summary below is the one shape.
  const answer =
    closure.size === 0
      ? { missing: [] as readonly string[], skippedUpstream: [] as readonly string[] }
      : await askMissing(resolved, headers, closure);
  const present = closure.size - answer.missing.length;
  const alreadyPresent = present - answer.skippedUpstream.length;
  // ONE PREAMBLE, then a line per path: what the closure is, what the bucket
  // already has, and what it will never take because an upstream key signed it.
  say(
    `${closure.size} paths in the closure: ${answer.missing.length} to push, ` +
      `${alreadyPresent} already here, ${answer.skippedUpstream.length} upstream`,
  );

  const failures: { path: string; message: string }[] = [];
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const width = options.concurrency ?? DEFAULT_CONCURRENCY;
  const partSize = options.partSize ?? DEFAULT_NAR_PART_BYTES;
  if (!Number.isSafeInteger(partSize) || partSize < 1 || partSize > MAX_NAR_PART_BYTES) {
    throw new Error(
      `a part must be between 1 and ${MAX_NAR_PART_BYTES} bytes (got ${partSize})`,
    );
  }
  let pushed = 0;

  /** Upload one dependency depth, reporting refusals as they happen. */
  const runWave = async (wave: readonly string[]): Promise<void> => {
    const queue = [...wave];
    const worker = async (): Promise<void> => {
      for (;;) {
        const storePath = queue.shift();
        if (storePath === undefined) return;
        const entry = closure.get(storePath);
        if (entry === undefined) continue;
        const outcome = await uploadOne(base, headers, entry, platform, attempts, say, {
          partSize,
        });
        if (outcome.ok) {
          pushed += 1;
          say(`✅ ${storePath} stored`);
          continue;
        }
        failures.push({ path: storePath, message: outcome.message });
        say(`❌ ${storePath} refused: ${outcome.message}`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(width, queue.length)) }, worker));
  };

  for (const wave of orderByDepth(closure, new Set(answer.missing))) {
    await runWave(wave);
  }

  const board = resolved.origin;
  return {
    pushed,
    skippedUpstream: answer.skippedUpstream.length,
    skippedDerivation,
    alreadyPresent,
    failed: failures.length,
    failures,
    pageUrl: `${board.replace(/\/$/, "")}/#/cache/${encodeURIComponent(resolved.name)}`,
  };
}

/**
 * Group the missing paths by their depth in the closure, shallowest first, so
 * every path is uploaded after the paths it references. A cycle (which a store
 * closure cannot contain) would leave a path unvisited; the visit set makes
 * that impossible and a self-reference settles at depth 0.
 */
function orderByDepth(closure: Map<string, ClosureEntry>, missing: Set<string>): string[][] {
  const depth = new Map<string, number>();
  const depthOf = (storePath: string, seen: Set<string>): number => {
    const known = depth.get(storePath);
    if (known !== undefined) return known;
    if (seen.has(storePath)) return 0;
    seen.add(storePath);
    let deepest = 0;
    for (const reference of closure.get(storePath)?.references ?? []) {
      if (reference === storePath || !missing.has(reference)) continue;
      deepest = Math.max(deepest, depthOf(reference, seen) + 1);
    }
    depth.set(storePath, deepest);
    return deepest;
  };
  const waves: string[][] = [];
  for (const storePath of missing) {
    const at = depthOf(storePath, new Set());
    (waves[at] ??= []).push(storePath);
  }
  return waves;
}

interface MissingAnswer {
  missing: string[];
  skippedUpstream: string[];
}

async function askMissing(
  bucket: ResolvedBucket,
  headers: Record<string, string>,
  closure: Map<string, ClosureEntry>,
  only?: ReadonlySet<string>,
): Promise<MissingAnswer> {
  const sending = only === undefined
    ? [...closure.values()]
    : [...closure.values()].filter((entry) => only.has(entry.storePath));
  const response = await fetch(
    `${bucket.origin}/_odu/v1/buckets/${bucket.name}/missing`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        paths: sending.map((entry) => ({
          path: entry.storePath,
          sigs: entry.sigs,
        })),
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `the bucket refused the missing-paths query: ${response.status} ${await response.text()}`,
    );
  }
  const body: unknown = await response.json();
  if (body === null || typeof body !== "object" || !("missing" in body)) {
    throw new Error("the bucket answered the missing-paths query without a `missing` list");
  }
  const missing = body.missing;
  if (!Array.isArray(missing)) throw new Error("the bucket's `missing` is not a list");
  const skipped = "skippedUpstream" in body && Array.isArray(body.skippedUpstream)
    ? body.skippedUpstream
    : [];
  return {
    missing: missing.filter((path): path is string => typeof path === "string"),
    skippedUpstream: skipped.filter((path): path is string => typeof path === "string"),
  };
}

/** A fetch rejection, as an Error. The `.catch` arm of an upload is a network
 *  failure and nothing else, so the two arms of the union stay narrow. */
function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

type UploadOutcome =
  | { ok: true }
  | { ok: false; message: string };

type NarUpload =
  | { ok: true }
  | { ok: false; message: string; retry: boolean };

/**
 * SLICE A NAR INTO REQUESTS UNDER THE PROXY'S CEILING.
 *
 * The parts are byte ranges of the COMPRESSED stream, so joining them in order
 * reproduces the exact bytes the single-request upload would have sent — and
 * the server's existing proof (decompress, hash, compare with the narinfo)
 * still decides. A part is held in memory only while it is written; the stream
 * is read with backpressure.
 */
async function* narParts(
  stream: ReadableStream<Uint8Array>,
  size: number,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let done = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.value !== undefined && next.value.length > 0) {
        pending.push(next.value);
        pendingBytes += next.value.length;
      }
      while (pendingBytes >= size) {
        const out = new Uint8Array(size);
        let at = 0;
        while (at < size) {
          const head = pending[0] as Uint8Array;
          const want = size - at;
          if (head.length <= want) {
            out.set(head, at);
            at += head.length;
            pending.shift();
          } else {
            out.set(head.subarray(0, want), at);
            pending[0] = head.subarray(want);
            at = size;
          }
        }
        pendingBytes -= size;
        yield out;
      }
      if (next.done) {
        done = true;
        break;
      }
    }
    if (pendingBytes > 0) {
      const out = new Uint8Array(pendingBytes);
      let at = 0;
      for (const part of pending) {
        out.set(part, at);
        at += part.length;
      }
      yield out;
    }
  } finally {
    // A path abandoned mid-stream must stop `nix store dump-path | zstd`,
    // not leave both writing into a pipe nobody reads.
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** One part, retried on its own. `index` makes the retry an overwrite, so the
 *  server never has to know which attempt it is. */
async function putPart(
  base: string,
  headers: Record<string, string>,
  narName: string,
  index: number,
  part: Uint8Array,
  attempts: number,
  say: (line: string) => void,
  storePath: string,
  session: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let lastMessage = "no attempt was made";
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) say(`↻ ${storePath} part ${index + 1} (retry ${attempt})`);
    const response = await fetch(`${base}/nar/${narName}/parts/${index}`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/x-nix-nar", [UPLOAD_SESSION_HEADER]: session },
      // Bun's fetch takes the bytes; the DOM `BodyInit` the type names does
      // not include this `Uint8Array` spelling.
      body: part as unknown as BodyInit,
    }).catch(asError);
    if (response instanceof Error) {
      lastMessage = response.message;
      continue;
    }
    if (response.ok) return { ok: true };
    lastMessage = `part ${index + 1} answered ${response.status}: ${(await response.text()).trim()}`;
    if (!worthRetrying(response.status)) break;
  }
  return { ok: false, message: lastMessage };
}

/**
 * THE NAR ITSELF, one request or several.
 *
 * A closure that fits in one part keeps the plain NAR route every Nix client
 * speaks; a larger one is split, each part retried alone, and joined by the
 * server before the narinfo is sent. The stream is inspected one part ahead,
 * so the choice costs one buffered part rather than the whole NAR.
 */
async function uploadNar(
  base: string,
  headers: Record<string, string>,
  entry: ClosureEntry,
  platform: PushPlatform,
  attempts: number,
  say: (line: string) => void,
  partSize: number,
  session: string,
): Promise<NarUpload> {
  const narName = `${narHashBase32(entry.narHash)}.nar.zst`;
  const parts = narParts(platform.dump(entry.storePath), partSize);
  const first = await parts.next();
  const second = await parts.next();

  if (second.done) {
    const body = first.done ? new Uint8Array(0) : first.value;
    const response = await fetch(`${base}/nar/${narName}`, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/x-nix-nar" },
      // Same spelling as the part upload: Bun takes the bytes.
      body: body as unknown as BodyInit,
    }).catch(asError);
    if (response instanceof Error) return { ok: false, message: response.message, retry: true };
    if (response.ok) return { ok: true };
    return {
      ok: false,
      message: `nar upload answered ${response.status}`,
      retry: worthRetrying(response.status),
    };
  }

  let index = 0;
  let current = first.value as Uint8Array;
  let ahead: IteratorResult<Uint8Array> = second;
  for (;;) {
    const sent = await putPart(
      base,
      headers,
      narName,
      index,
      current,
      attempts,
      say,
      entry.storePath,
      session,
    );
    if (!sent.ok) {
      await parts.return(undefined as never);
      return { ok: false, message: sent.message, retry: true };
    }
    // PROGRESS for a large path: one line per part, so a slow upload reads as
    // work rather than as the old silence.
    say(`⏳ ${entry.storePath} part ${index + 1}`);
    index += 1;
    if (ahead.done) break;
    current = ahead.value;
    ahead = await parts.next();
  }

  const joined = await fetch(`${base}/nar/${narName}/complete`, {
    method: "POST",
    headers: { ...headers, [PARTS_HEADER]: String(index), [UPLOAD_SESSION_HEADER]: session },
  }).catch(asError);
  if (joined instanceof Error) return { ok: false, message: joined.message, retry: true };
  if (!joined.ok) {
    return {
      ok: false,
      message: `joining ${index} parts answered ${joined.status}: ${(await joined.text()).trim()}`,
      retry: worthRetrying(joined.status),
    };
  }
  return { ok: true };
}

async function uploadOne(
  base: string,
  headers: Record<string, string>,
  entry: ClosureEntry,
  platform: PushPlatform,
  attempts: number,
  say: (line: string) => void,
  options: { partSize: number },
): Promise<UploadOutcome> {
  let lastMessage = "no attempt was made";
  const narinfoOnly = false;
  const narName = `${narHashBase32(entry.narHash)}.nar.zst`;
  // THIS PATH'S OWN PARTS (contract 2.4): another pusher of the same path, at
  // another zstd level, cannot have its parts joined into ours. ONE session for
  // every attempt, so a retry overwrites its own parts rather than abandoning
  // them to the hour-long sweep. An older server ignores the header.
  const session = randomUUID();
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!narinfoOnly) {
      const uploaded = await uploadNar(
        base,
        headers,
        entry,
        platform,
        attempts,
        say,
        options.partSize,
        session,
      );
      if (!uploaded.ok) {
        lastMessage = uploaded.message;
        if (!uploaded.retry) break;
        continue;
      }
    }
    const infoResponse = await fetch(`${base}/${storePathHash(entry.storePath)}.narinfo`, {
      method: "PUT",
      headers: { ...headers, "content-type": "text/x-nix-narinfo" },
      body: formatPushNarinfo(entry, narName),
    }).catch(asError);
    if (infoResponse instanceof Error) {
      lastMessage = infoResponse.message;
      continue;
    }
    // 200 IS STORED, and it is the only answer that is. Any other status —
    // a success code this pusher does not know included — is a refusal like any
    // other, said with the server's own words and not repeated.
    if (infoResponse.status === 200) return { ok: true };
    const said = await infoResponse.text();
    lastMessage = `narinfo upload answered ${infoResponse.status}: ${said}`;
    if (infoResponse.ok || !worthRetrying(infoResponse.status)) break;
  }
  return { ok: false, message: lastMessage };
}

/** What the client sends. The server re-signs it; the client's own signatures
 *  ride along so a path signed on a lane stays verifiable after the round trip. */
export function formatPushNarinfo(entry: ClosureEntry, narName: string): string {
  return [
    `StorePath: ${entry.storePath}`,
    `URL: nar/${narName}`,
    "Compression: zstd",
    `NarHash: ${entry.narHash}`,
    `NarSize: ${entry.narSize}`,
    `References: ${entry.references.map(storePathBasename).join(" ")}`,
    ...(entry.deriver === null ? [] : [`Deriver: ${storePathBasename(entry.deriver)}`]),
    ...entry.sigs.map((sig) => `Sig: ${sig}`),
    "",
  ].join("\n");
}
