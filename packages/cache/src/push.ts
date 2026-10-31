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
 * **Uploads go in dependency order.** The server imports each narinfo through
 * `nix copy --from`, and Nix refuses a path whose references are not valid yet.
 * So paths are ordered by their depth in the closure and pushed shallowest
 * first; the concurrency is applied WITHIN a depth, never across one.
 *
 * **A NAR is never in memory.** Each upload is `nix store dump-path | zstd -T0
 * -c` piped straight into the request body, which is why this can push a
 * multi-gigabyte closure on a laptop.
 */

import { readFile } from "node:fs/promises";
import {
  credentialsPath as sharedCredentialsPath,
  normalizeOrigin,
  readCredentials as sharedReadCredentials,
  saveCredential as sharedSaveCredential,
} from "@odu/credentials";
import { narHashBase32, storePathBasename, storePathHash } from "./narinfo";
import { CACHE_MOUNT } from "./paths";
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
  alreadyPresent: number;
  failed: number;
  /** One line per failure, for a caller that wants to say which paths did not
   *  make it. */
  failures: readonly { path: string; message: string }[];
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

/** How many times a deferred upload is repeated after the waves that could
 *  unblock it. Two is enough for any closure a real store produces — the
 *  depth of the graph, not its size. */
const DEFERRED_ROUNDS = 2;

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
  const closure = new Map((await platform.closure(options.paths)).map((info) => [info.storePath, info]));
  const answer = await askMissing(resolved, headers, closure);
  const present = closure.size - answer.missing.length;
  say(
    `${closure.size} paths in the closure, ${answer.missing.length} missing from ` +
      `"${resolved.name}", ${present} already there or upstream`,
  );

  const failed: { path: string; message: string }[] = [];
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const width = options.concurrency ?? DEFAULT_CONCURRENCY;

  /** Upload one wave, answering the paths the server accepted but is still
   *  waiting on — a reference of theirs was skipped as upstream, or arrived
   *  out of order. */
  const runWave = async (wave: readonly string[], narinfoOnly = false): Promise<string[]> => {
    const queue = [...wave];
    const deferred: string[] = [];
    const worker = async (): Promise<void> => {
      for (;;) {
        const storePath = queue.shift();
        if (storePath === undefined) return;
        const entry = closure.get(storePath);
        if (entry === undefined) continue;
        const outcome = await uploadOne(base, headers, entry, platform, attempts, { narinfoOnly });
        if (outcome.ok === "deferred") deferred.push(storePath);
        else if (!outcome.ok) failed.push({ path: storePath, message: outcome.message });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(width, queue.length)) }, worker));
    return deferred;
  };

  let deferred: string[] = [];
  for (const wave of orderByDepth(closure, new Set(answer.missing))) {
    deferred.push(...(await runWave(wave)));
  }

  // A DEFERRED path is one the server accepted and could not import yet: its
  // references had not landed when it arrived. They have now, so the same
  // upload is repeated — a bounded number of times, because a reference the
  // pusher skipped as upstream will never arrive from here.
  for (let round = 0; deferred.length > 0 && round < DEFERRED_ROUNDS; round++) {
    const retrying = [...deferred];
    // The NAR is still staged on the server (a 202 keeps it), so the repeat is
    // the narinfo alone — re-streaming a multi-gigabyte NAR to say "try again"
    // is the cost this avoids. A 400 that says the bytes are gone falls back to
    // the full pair inside `uploadOne`.
    deferred = await runWave(retrying, true);
    if (deferred.length === retrying.length) break;
  }
  for (const storePath of deferred) {
    failed.push({
      path: storePath,
      message:
        "accepted, but still waiting on references the bucket does not have — " +
        "a reference signed by an upstream key is not uploaded by this push",
    });
  }

  return {
    pushed: closure.size - present - failed.length,
    skippedUpstream: answer.skippedUpstream.length,
    alreadyPresent: present - answer.skippedUpstream.length,
    failed: failed.length,
    failures: failed,
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
): Promise<MissingAnswer> {
  const response = await fetch(
    `${bucket.origin}/_odu/v1/buckets/${bucket.name}/missing`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        paths: [...closure.values()].map((entry) => ({
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
  /** The server took it and cannot import it yet — a reference has not landed. */
  | { ok: "deferred" }
  | { ok: false; message: string };

async function uploadOne(
  base: string,
  headers: Record<string, string>,
  entry: ClosureEntry,
  platform: PushPlatform,
  attempts: number,
  options: { narinfoOnly?: boolean } = {},
): Promise<UploadOutcome> {
  let lastMessage = "no attempt was made";
  let narinfoOnly = options.narinfoOnly === true;
  const narName = `${narHashBase32(entry.narHash)}.nar.zst`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!narinfoOnly) {
      // The body is held so it can be CANCELLED: a refused upload that leaves
      // `nix store dump-path | zstd` writing into a full pipe holds both
      // processes for as long as the socket lives.
      const body = platform.dump(entry.storePath);
      const narResponse = await fetch(`${base}/nar/${narName}`, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/x-nix-nar" },
        body,
        // A streamed body has no length; Node's fetch demands this and Bun
        // ignores it, so it is set for both rather than special-cased.
        duplex: "half",
      } as RequestInit).catch(asError);
      if (narResponse instanceof Error) {
        void body.cancel().catch(() => {});
        lastMessage = narResponse.message;
        continue;
      }
      if (!narResponse.ok) {
        void body.cancel().catch(() => {});
        lastMessage = `nar upload answered ${narResponse.status}`;
        if (!worthRetrying(narResponse.status)) break;
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
    if (infoResponse.status === 202) return { ok: "deferred" };
    if (infoResponse.ok) return { ok: true };
    const said = await infoResponse.text();
    lastMessage = `narinfo upload answered ${infoResponse.status}: ${said}`;
    if (narinfoOnly && infoResponse.status === 400 && said.includes("never uploaded")) {
      // The server no longer has the bytes — a restart, or a sweep. Send the
      // pair rather than asking again.
      narinfoOnly = false;
      continue;
    }
    if (!worthRetrying(infoResponse.status)) break;
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
