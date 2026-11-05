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
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
import {
  CACHE_MOUNT,
  ODU_BUCKET_FIELD,
  ODU_ORIGIN_FIELD,
  PARTS_HEADER,
  UPLOAD_SESSION_HEADER,
  type UploadMode,
  type UploadPlan,
} from "./paths";
import { DEFAULT_NAR_PART_BYTES, MAX_NAR_PART_BYTES, UPLOAD_NEGOTIATION_SINCE } from "./surface";
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

/**
 * WHAT A SUBSTITUTER SAYS ABOUT ITSELF — `odu cache push --cache <url>`.
 *
 * A consumer repository knows ONE fact about its cache: the URL its `nix.conf`
 * substitutes from. Everything else it used to hard-code — the push origin and
 * the bucket name — is now stated by the cache, in `nix-cache-info`, the file a
 * Nix client fetches before anything else. It has to be stated rather than
 * derived because reads come from the store (PLAN 2.8): `https://cache.kolu.dev`
 * is an R2 domain that answers GET and takes no push at all.
 *
 * IT CARRIES THE BUCKET'S TOKEN. An anonymous read of a PRIVATE bucket is
 * `404 no such bucket` — the cache refuses to confirm a private name to
 * somebody who has not proved anything — so discovery without a credential
 * would make exactly the buckets that need a token unpushable. The token is
 * the same one the push that follows uses, resolved from the same places
 * ({@link discoveryToken}), and a public bucket ignores it. It is the push's
 * own authority sent one request earlier, so nothing is granted by this.
 *
 * WHAT THE TOKEN TRAVELS TO is the SUBSTITUTER the caller named, and the push
 * then travels to the origin that file states. Naming a cache is trusting it.
 *
 * BOTH LINES OR NOTHING. A cache that answers a `nix-cache-info` without them
 * is a cache this cannot push to — some other implementation, or an odu from
 * before this — and guessing an origin from the substituter is how a push ends
 * up at a URL nobody owns. The refusal names the URL it asked.
 */
export interface DescribedCache {
  /** `Odu-Origin`: the daemon that takes the push. */
  origin: string;
  /** `Odu-Bucket`: which bucket at that daemon this substituter serves. */
  bucket: string;
}

export async function describeCache(
  substituter: string,
  send: typeof fetch = fetch,
  /** The bucket's token when this machine has one. Null is a legitimate
   *  answer — a public bucket needs none — and a private one then refuses
   *  with the sentence that says so. */
  token: string | null = null,
): Promise<DescribedCache> {
  const url = `${substituter.trim().replace(/\/$/, "")}/nix-cache-info`;
  let response: Response;
  try {
    response = await send(
      url,
      token === null ? {} : { headers: { authorization: `Bearer ${token}` } },
    );
  } catch (err) {
    throw new Error(
      `${url} could not be read (${err instanceof Error ? err.message : String(err)}) — ` +
        `--cache takes the substituter URL your nix.conf uses, and this one did not answer`,
    );
  }
  if (!response.ok) {
    // A PRIVATE BUCKET IS A 404 TO A READER WITHOUT A TOKEN, and a 403 to one
    // whose token cannot read it, so the status alone cannot tell "no such
    // cache" from "not yours". What decides the next move is whether a token
    // was sent at all, so that is what the sentence says.
    const why =
      token === null
        ? "and no token was sent — a PRIVATE bucket answers its nix-cache-info to " +
          "nobody. Set $ODU_CACHE_TOKEN (or --token-file), or check the URL"
        : "for the token this machine holds — check the URL, and that the token " +
          "may read this bucket";
    throw new Error(`${url} answered ${response.status} ${why}`);
  }
  const text = await response.text();
  const origin = infoField(text, ODU_ORIGIN_FIELD);
  const bucket = infoField(text, ODU_BUCKET_FIELD);
  if (origin === null || bucket === null) {
    throw new Error(
      `${url} does not say where it is pushed to: a cache odu can push to states ` +
        `${ODU_ORIGIN_FIELD} and ${ODU_BUCKET_FIELD} there. Name the bucket and its ` +
        `origin instead (\`odu cache push <bucket> --origin <url>\`), or upgrade the ` +
        `odu that serves it`,
    );
  }
  return { origin: normalizeOrigin(origin), bucket };
}

/**
 * THE TOKEN DISCOVERY CARRIES — the push's own resolution, asked one origin
 * earlier.
 *
 * `resolveToken` already is that order (`--token-file`, `$ODU_CACHE_TOKEN`,
 * then the credential for an ORIGIN), and the only thing discovery has to
 * decide is WHICH origin, because the push's own is the fact being
 * discovered. It is the substituter's — where this request is going, and for
 * a private bucket odu itself, since a private bucket is never store-fronted.
 * So a machine that ran `odu cache login` against the cache it reads can
 * discover it.
 */
export async function discoveryToken(
  env: PushEnv,
  substituter: string,
  tokenFile: string | undefined,
): Promise<string | null> {
  let origin: string;
  try {
    const url = new URL(substituter);
    origin = `${url.protocol}//${url.host}`;
  } catch {
    // Not a URL at all: the file and the variable still answer, and no
    // credential is keyed under a name this is not.
    origin = substituter;
  }
  return resolveToken(env, origin, tokenFile);
}

/** One field of a `nix-cache-info`, or null. The format is `Key: value` a line
 *  at a time; the key is matched case-insensitively because the only cost of
 *  doing so is nothing, and `\r` is stripped for the proxy that adds one. */
function infoField(text: string, field: string): string | null {
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    if (line.slice(0, at).trim().toLowerCase() !== field.toLowerCase()) continue;
    const value = line.slice(at + 1).trim();
    if (value !== "") return value;
  }
  return null;
}

// ── what a repository already says about its cache ──────────────────────────

/**
 * THE ONE DECLARATION A REPOSITORY ALREADY HAS — `flake.nix`'s `nixConfig`
 * (PLAN 4.1).
 *
 * A repo that reads from an odu cache names it exactly once, in the
 * `extra-substituters` line a consumer pastes out of `odu cache use`. Nothing
 * else needs to be true for a run to push there: no recipe step, no token in
 * the tree, no `.odu` key, no second place a bucket name can go stale.
 *
 * **`-f flake.nix`, not `nix flake metadata`.** `nixConfig` is a plain attrset
 * at the top of the file, so evaluating the FILE answers it without fetching a
 * single input — which on a cold checkout is the difference between a
 * millisecond and a download of nixpkgs. The cost is that a `nixConfig` built
 * by a `let` over an input would not evaluate; no repository writes one, and a
 * failure is reported rather than guessed at.
 *
 * **A value is a string or a list.** Nix accepts both spellings for every
 * multi-valued setting, and a repository that writes
 * `extra-substituters = "a b"` means the same two caches as one that writes a
 * list of two.
 */
export interface FlakeNixConfig {
  /** `substituters` ∪ `extra-substituters`, in declaration order. */
  substituters: readonly string[];
  /** `trusted-public-keys` ∪ `extra-trusted-public-keys`. */
  trustedPublicKeys: readonly string[];
}

export type FlakeNixConfigOutcome =
  | { ok: true; config: FlakeNixConfig }
  /** No `flake.nix`, or one `nix eval` would not read. `reason` is a sentence
   *  naming which — it is what a run's setup log prints, so it has to say why
   *  nothing was pushed rather than merely that nothing was. */
  | { ok: false; reason: string };

/** How a `nix eval` is run. Injected so the resolver's arms — no flake, an
 *  eval error, a `nixConfig` of the wrong shape — are stated without a Nix. */
export type NixEval = (
  dir: string,
) => { ok: true; json: string } | { ok: false; stderr: string };

/** One multi-valued `nixConfig` setting as a list of words, from either
 *  spelling. Anything else (a number, a bool, a nested attrset) contributes
 *  nothing: the settings this reads are lists of strings and a repository that
 *  wrote something else did not name a substituter. */
function settingWords(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(/\s+/).filter((word) => word !== "");
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => (typeof item === "string" ? settingWords(item) : []));
  }
  return [];
}

/** Both spellings of one setting, in declaration order and without repeats. */
function unioned(config: Record<string, unknown>, plain: string): string[] {
  const out: string[] = [];
  for (const key of [plain, `extra-${plain}`]) {
    for (const word of settingWords(config[key])) {
      if (!out.includes(word)) out.push(word);
    }
  }
  return out;
}

/** `nix eval --json -f flake.nix nixConfig`, with no input fetched. */
export const nixEvalFlakeConfig: NixEval = (dir) => {
  const result = spawnSync(
    "nix",
    ["eval", "--json", "-f", "flake.nix", "nixConfig"],
    { cwd: dir, encoding: "utf-8", timeout: FLAKE_EVAL_TIMEOUT_MS },
  );
  if (result.status === 0) return { ok: true, json: result.stdout };
  const said = (result.stderr ?? "").trim().split("\n").filter((line) => line.trim() !== "");
  return {
    ok: false,
    // THE LAST LINE, which is where `nix eval` puts the fault; the ones above
    // it are the trace. One line, because this reaches a run's setup log and a
    // forty-line Nix trace there is noise standing in front of the answer.
    stderr: said[said.length - 1]?.trim() ?? (result.error?.message ?? "nix eval failed"),
  };
};

/** How long a `nixConfig` evaluation may take. It fetches nothing and parses
 *  one file, so this is a backstop against a hung `nix`, not a budget. */
const FLAKE_EVAL_TIMEOUT_MS = 30_000;

/** What a checkout's `flake.nix` declares about the caches it reads from. */
export function readFlakeNixConfig(
  dir: string,
  evaluate: NixEval = nixEvalFlakeConfig,
): FlakeNixConfigOutcome {
  if (!existsSync(join(dir, "flake.nix"))) {
    return { ok: false, reason: "no flake.nix" };
  }
  const evaluated = evaluate(dir);
  if (!evaluated.ok) {
    return { ok: false, reason: `flake.nix nixConfig could not be read — ${evaluated.stderr}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(evaluated.json);
  } catch {
    return { ok: false, reason: "flake.nix nixConfig did not evaluate to JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "flake.nix has no nixConfig attrset" };
  }
  const config = parsed as Record<string, unknown>;
  return {
    ok: true,
    config: {
      substituters: unioned(config, "substituters"),
      trustedPublicKeys: unioned(config, "trusted-public-keys"),
    },
  };
}

/** A substituter that answered as an odu cache — the URL asked, and the two
 *  lines it said about itself. */
export interface OduSubstituter extends DescribedCache {
  substituter: string;
}

/** How long one `nix-cache-info` probe may take. Bounded because this runs on
 *  the path of `run.start`, which a caller is waiting on, and a substituter
 *  that is down must cost a timeout rather than the run. */
export const CACHE_PROBE_TIMEOUT_MS = 5_000;

/**
 * WHICH OF THESE SUBSTITUTERS ARE ODU CACHES — asked of each one, in parallel,
 * with a bounded wait.
 *
 * A substituter that does not answer, or answers without `Odu-Origin` and
 * `Odu-Bucket`, is IGNORED rather than refused: `cache.nixos.org` is in a great
 * many `nixConfig`s and is nobody's push target. The refusals this resolution
 * can produce are about odu caches, which is what {@link describeCache} already
 * says and the reason this reuses it rather than parsing the file again.
 */
export async function oduCachesOf(
  substituters: readonly string[],
  options: {
    send?: typeof fetch;
    /** The credential a PRIVATE bucket's `nix-cache-info` needs. */
    token?: string | null;
    timeoutMs?: number;
  } = {},
): Promise<OduSubstituter[]> {
  const send = options.send ?? fetch;
  const timeoutMs = options.timeoutMs ?? CACHE_PROBE_TIMEOUT_MS;
  // `typeof fetch` carries Bun's `preconnect` property, which a plain lambda
  // cannot have and `describeCache` never calls. The cast names that gap
  // rather than widening the parameter every other caller depends on.
  const bounded = ((input: string, init?: RequestInit) =>
    send(input, { ...(init ?? {}), signal: AbortSignal.timeout(timeoutMs) })) as typeof fetch;
  const described = await Promise.all(
    substituters.map(async (substituter) => {
      try {
        const facts = await describeCache(substituter, bounded, options.token ?? null);
        return { substituter, ...facts };
      } catch {
        // NOT AN ODU CACHE, or not reachable. Either way this is not the
        // repository's push target and saying so would be noise on every run
        // of every repo that substitutes from nixos.org.
        return null;
      }
    }),
  );
  return described.filter((one): one is OduSubstituter => one !== null);
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
  /**
   * HOW MUCH THIS PUSH STORED — the NAR size of every path it uploaded, summed.
   *
   * The UNCOMPRESSED size, which is what the closure states and what a reader
   * comparing it with `nix path-info -S` expects; what crossed the wire is
   * whatever zstd made of it. Zero when nothing was uploaded, a closure the
   * bucket already held included.
   */
  bytes: number;
  /** Paths the bucket already has, or would not take because an upstream key
   *  signed them. The server says which is which. */
  skippedUpstream: number;
  /** Derivations the caller named. A cache serves outputs; a `.drv` is a
   *  recipe, and its references are recipes. */
  skippedDerivation: readonly string[];
  /**
   * HOW THE BYTES TRAVELLED (PLAN 2.9) — `direct` when the bucket's store
   * took them itself through presigned URLs, `staged` when they crossed the
   * daemon, `null` when this push uploaded nothing. The bucket's store
   * decides it, so one push is one mode.
   */
  mode: UploadMode | null;
  alreadyPresent: number;
  failed: number;
  /** One line per failure, for a caller that wants to say which paths did not
   *  make it. */
  failures: readonly { path: string; message: string }[];
  /** WHAT THE BUCKET SERVES NOW, by name: everything in the closure it already
   *  had, plus everything this push stored. A caller that promises "every
   *  pushed path answers" checks THIS list, not the closure — the closure also
   *  holds the upstream-signed paths the bucket refuses by design and the paths
   *  whose upload was refused, so verifying it would go red on the paths the
   *  bucket is right to lack. */
  served: readonly string[];
  /** THE ADDRESS A NIX CLIENT SUBSTITUTES IT FROM — the bucket's own domain
   *  when it has one, else the mount path. A caller PROVING the push asks this
   *  address, because it is the one Nix asks: `<substituter>/<hash>.narinfo`.
   *  Read from the bucket, not assembled here: only the daemon knows whether a
   *  name stands in front. */
  substituter: string;
  /** THE PIN THIS PUSH RE-POINTED, when one was asked for: its name and how
   *  many paths the closure it now holds has. Null when none was. */
  pinned: { name: string; rootPaths: number } | null;
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
  /**
   * RE-POINT THIS PIN AT WHAT WAS PUSHED, by name — the one thing CI needs to
   * keep a master closure out of collection (`.github/actions/push`'s `pin:`).
   *
   * It runs AFTER the uploads and only when every one of them landed: a pin
   * over a half-pushed closure would promise to keep paths the bucket does not
   * have. The bucket resolves the closure itself from the roots named here,
   * and the write token is the whole authority — see the route's own note on
   * why write, not admin.
   */
  pin?: string;
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
      ? {
          missing: [] as readonly string[],
          skippedUpstream: [] as readonly string[],
          substituter: null,
        }
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
  /** NAR bytes this push stored, summed as each upload lands. */
  let bytes = 0;
  /** What the bucket answered the negotiation with — one store, one mode. */
  let mode: UploadMode | null = null;

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
          bytes += entry.narSize;
          mode = outcome.mode;
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
  // SERVED, derived from the three verdicts rather than from a fourth query:
  // a closure member is served when the bucket either already had it or took
  // it now, and it is not served when an upstream key signed it or the upload
  // was refused.
  const refused = new Set(failures.map((failure) => failure.path));
  const upstream = new Set(answer.skippedUpstream);
  const served = [...closure.keys()].filter(
    (storePath) => !refused.has(storePath) && !upstream.has(storePath),
  );

  // THE PIN, LAST AND ONLY IF NOTHING WAS REFUSED. A pin names the roots the
  // CALLER asked for — the bucket walks their closure in its own rows — and
  // over a half-pushed closure it would promise to keep paths that are not
  // there. A refusal here is thrown, not counted: a caller that asked for a
  // pin and did not get one has not done what it was told.
  const pinned =
    options.pin === undefined || options.pin === "" || failures.length > 0
      ? null
      : await pinClosure(resolved, headers, options.pin, served, say);
  return {
    pushed,
    bytes,
    mode,
    skippedUpstream: answer.skippedUpstream.length,
    skippedDerivation,
    alreadyPresent,
    failed: failures.length,
    failures,
    served,
    // THE BUCKET'S OWN ANSWER when it gave one — a daemon that predates the
    // field gets the path form this client addressed it at, which is the same
    // URL for a bucket with no domain and the honest approximation for one
    // that has a name nobody here was told.
    substituter: answer.substituter ?? base,
    pinned,
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
  /** The address the bucket says Nix substitutes it from. `null` from a daemon
   *  that predates the field, so a caller falls back to the mount path it
   *  built its request from. */
  substituter: string | null;
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
  const substituter =
    "substituter" in body && typeof body.substituter === "string" ? body.substituter : null;
  return {
    missing: missing.filter((path): path is string => typeof path === "string"),
    skippedUpstream: skipped.filter((path): path is string => typeof path === "string"),
    substituter,
  };
}

/**
 * RE-POINT A NAMED PIN AT WHAT THIS BUCKET NOW SERVES.
 *
 * The roots are the SERVED paths — the closure minus what an upstream key
 * signed and minus what was refused — because a pin may only name paths the
 * bucket holds, and the bucket walks their references itself. A name that
 * already exists is re-pointed, which is the whole behaviour CI wants: today's
 * master closure held, yesterday's let go.
 *
 * The write token is the authority (the route's own note says why), so this
 * needs nothing a push did not already have.
 */
async function pinClosure(
  bucket: ResolvedBucket,
  headers: Record<string, string>,
  name: string,
  served: readonly string[],
  say: (line: string) => void,
): Promise<{ name: string; rootPaths: number }> {
  const response = await fetch(`${bucket.origin}/_odu/v1/buckets/${bucket.name}/pin`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name, paths: served }),
  });
  if (!response.ok) {
    throw new Error(
      `the bucket refused the pin "${name}": ${response.status} ${await response.text()}`,
    );
  }
  // WHAT THE BUCKET SAYS IT HOLDS, never what this client sent: the closure
  // is resolved there, so its own roots are the only true count — and a
  // daemon that answered something else has not done what was asked.
  const body: unknown = await response.json();
  if (
    body === null ||
    typeof body !== "object" ||
    !("rootPaths" in body) ||
    !Array.isArray(body.rootPaths)
  ) {
    throw new Error(`the bucket answered the pin "${name}" without a \`rootPaths\` list`);
  }
  const rootPaths = body.rootPaths.length;
  say(`📌 ${name} now holds ${rootPaths} paths`);
  return { name, rootPaths };
}

/** A fetch rejection, as an Error. The `.catch` arm of an upload is a network
 *  failure and nothing else, so the two arms of the union stay narrow. */
function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

type UploadOutcome =
  | { ok: true; mode: UploadMode }
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
 * WHERE THIS NAR'S BYTES GO — asked once per path, before any are sent.
 *
 * The CACHE answers from the bucket's store, so there is no flag and no
 * probe: `direct` hands back URLs that write the store itself, `staged` means
 * the NAR route this client has always used. A 404 is an origin from before
 * the negotiation, and this client does NOT fall back — a store-backed bucket
 * would then silently go on pushing every byte through the daemon, which is
 * the thing 2.9 removes — so it says which version it needs and stops.
 */
async function beginUpload(
  base: string,
  headers: Record<string, string>,
  narName: string,
  partSize: number,
): Promise<UploadPlan | { error: string; retry: boolean }> {
  const response = await fetch(`${base}/nar/${narName}/upload`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    // THE CLIENT'S `--part-size`, as a FLOOR: in direct mode there is no
    // proxy body limit to stay under, and the server raises it to what S3
    // and the store demand.
    body: JSON.stringify({ partSize }),
  }).catch(asError);
  if (response instanceof Error) return { error: response.message, retry: true };
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return {
      error:
        `${base} does not take uploads this way: it predates cache surface ` +
        `${UPLOAD_NEGOTIATION_SINCE}, which added the upload negotiation — upgrade the cache`,
      retry: false,
    };
  }
  if (!response.ok) {
    return {
      error: `beginning the upload answered ${response.status}: ${(await response.text()).trim()}`,
      retry: worthRetrying(response.status),
    };
  }
  const plan = (await response.json()) as UploadPlan;
  if (plan.mode !== "direct" && plan.mode !== "staged") {
    return { error: `the cache answered an upload mode this client does not know`, retry: false };
  }
  return plan;
}

/** One PART, PUT to the STORE. No odu header rides along: the URL carries
 *  its own authority, and an `Authorization` beside a presigned signature is
 *  what an S3 service refuses. */
async function putToStore(
  url: string,
  body: Uint8Array,
): Promise<{ ok: true; etag: string | null } | { ok: false; message: string }> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-length": String(body.length) },
    // Bun's fetch takes the bytes; the DOM `BodyInit` the type names does not
    // include this `Uint8Array` spelling.
    body: body as unknown as BodyInit,
  }).catch(asError);
  if (response instanceof Error) return { ok: false, message: response.message };
  if (!response.ok) {
    return {
      ok: false,
      message: `the store answered ${response.status} to a presigned PUT: ${(await response.text()).trim()}`,
    };
  }
  await response.body?.cancel().catch(() => {});
  return { ok: true, etag: response.headers.get("etag") };
}

/**
 * THE NAR, STRAIGHT INTO THE STORE (PLAN 2.9).
 *
 * EVERY BYTE IS A PART, a one-part NAR included, and the plan carries part
 * 0's URL so that common case still costs three requests. Parts are what the
 * store lets odu take back: completing the upload kills their URLs, and odu
 * signs nothing else for the key, so the object it proves afterwards is one
 * nobody can rewrite. A plain presigned PUT would be one request fewer and a
 * key writable for ten minutes.
 *
 * EVERY failure here re-begins the path rather than retrying in place: a
 * presign is minted for ten minutes, so the 4xx a slow part earns is an
 * expiry, and a fresh upload id costs one `begin` against an upload whose
 * state nobody can inspect.
 */
async function uploadDirect(
  base: string,
  headers: Record<string, string>,
  entry: ClosureEntry,
  platform: PushPlatform,
  say: (line: string) => void,
  plan: Extract<UploadPlan, { mode: "direct" }>,
  narName: string,
): Promise<NarUpload> {
  const parts = narParts(platform.dump(entry.storePath), plan.partSize);
  const done: { index: number; etag: string }[] = [];
  const first = await parts.next();
  let current = first.done ? new Uint8Array(0) : first.value;
  let ahead: IteratorResult<Uint8Array> = await parts.next();

  for (let index = 0; ; index += 1) {
    // PART 0'S URL CAME WITH THE PLAN; the rest are asked for one at a time,
    // which costs a round trip only on a NAR that is already several parts.
    let url = plan.part;
    if (index > 0) {
      const signed = await fetch(`${base}/nar/${narName}/upload/${plan.upload}/parts/${index}`, {
        headers,
      }).catch(asError);
      if (signed instanceof Error) {
        await parts.return(undefined as never);
        return { ok: false, message: signed.message, retry: true };
      }
      if (!signed.ok) {
        await parts.return(undefined as never);
        return {
          ok: false,
          message: `signing part ${index + 1} answered ${signed.status}: ${(await signed.text()).trim()}`,
          // THIS IS ODU ANSWERING, not the store, so the shared rule decides
          // — plus the one status whose meaning odu defines here: a `404` is
          // an upload this daemon no longer holds, and beginning again is
          // exactly its answer. A `403` is a token that will not improve.
          retry: signed.status === 404 || worthRetrying(signed.status),
        };
      }
      ({ url } = (await signed.json()) as { url: string });
    }
    const sent = await putToStore(url, current);
    if (!sent.ok) {
      await parts.return(undefined as never);
      return { ok: false, message: sent.message, retry: true };
    }
    if (sent.etag === null) {
      await parts.return(undefined as never);
      return {
        ok: false,
        message: `the store took part ${index + 1} without an ETag, which the join needs`,
        retry: false,
      };
    }
    done.push({ index, etag: sent.etag });
    // PROGRESS for a large path: one line per part, so a slow upload reads
    // as work rather than as the old silence.
    if (index > 0) say(`⏳ ${entry.storePath} part ${index + 1} → store`);
    if (ahead.done) break;
    current = ahead.value;
    ahead = await parts.next();
  }

  const joined = await fetch(`${base}/nar/${narName}/upload/${plan.upload}/complete`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ parts: done }),
  }).catch(asError);
  if (joined instanceof Error) return { ok: false, message: joined.message, retry: true };
  if (!joined.ok) {
    // EVERY REFUSAL HERE RE-BEGINS THE PATH. The upload this one names is
    // finished with either way — odu drops it on a refusal — and the reachable
    // causes are not the client's to correct in place: a store that would not
    // join the parts, an object that never landed, an id this daemon no longer
    // holds. A new upload id is the only answer any of them has, and the
    // attempt budget bounds it.
    return {
      ok: false,
      message: `finishing the upload answered ${joined.status}: ${(await joined.text()).trim()}`,
      retry: true,
    };
  }
  await joined.body?.cancel().catch(() => {});
  return { ok: true };
}

/**
 * THE NAR ITSELF, one request or several — through odu, into staging.
 *
 * A closure that fits in one part keeps the plain NAR route every Nix client
 * speaks; a larger one is split, each part retried alone, and joined by the
 * server before the narinfo is sent. The stream is inspected one part ahead,
 * so the choice costs one buffered part rather than the whole NAR.
 */
async function uploadStaged(
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

  const narName = `${narHashBase32(entry.narHash)}.nar.zst`;
  // THIS PATH'S OWN PARTS (since the cache row's 2.4): another pusher of the same path, at
  // another zstd level, cannot have its parts joined into ours. ONE session for
  // every attempt, so a retry overwrites its own parts rather than abandoning
  // them to the hour-long sweep. An older server ignores the header.
  const session = randomUUID();
  // WHICH MODE A BUCKET TAKES is a fact about its STORE: it changes when the
  // bucket is moved between stores, twice in its life, not between attempts.
  // A DIRECT upload's handle is per attempt, though — a retry is a new upload
  // id, which is what makes an expired presign or a restarted daemon a retry
  // rather than a refusal — so only that mode asks again.
  let plan = await beginUpload(base, headers, narName, options.partSize);
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0 && ("error" in plan || plan.mode === "direct")) {
      plan = await beginUpload(base, headers, narName, options.partSize);
    }
    if ("error" in plan) {
      lastMessage = plan.error;
      if (!plan.retry) break;
      continue;
    }
    const uploaded =
      plan.mode === "direct"
        ? await uploadDirect(base, headers, entry, platform, say, plan, narName)
        : await uploadStaged(
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
    if (infoResponse.status === 200) return { ok: true, mode: plan.mode };
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
