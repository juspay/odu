import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialsPath as sharedCredentialsPath,
  normalizeOrigin,
  readCredentials as sharedReadCredentials,
  saveCredential as sharedSaveCredential,
} from "@odu/credentials";
import { describeFailure } from "./failure";
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
  provenanceHeaders,
  UPLOAD_SESSION_HEADER,
  type UploadMode,
  type UploadPlan,
} from "./paths";
import {
  DEFAULT_NAR_PART_BYTES,
  MAX_NAR_PART_BYTES,
  UPLOAD_NEGOTIATION_SINCE,
  WHOLE_PUSH_SINCE,
} from "./surface";
import { type PathInfo, nixClosure, nixDump } from "./store";

export interface PushEnv {
  readonly ODU_CACHE_TOKEN?: string | undefined;
  readonly ODU_WEB_ORIGIN?: string | undefined;
  readonly HOME?: string | undefined;
  readonly XDG_CONFIG_HOME?: string | undefined;
  readonly [other: string]: string | undefined;
}

const STORE = "cache";

export const credentialsPath = (env: PushEnv): string => sharedCredentialsPath(env, STORE);

const readCredentials = (env: PushEnv): Promise<Record<string, string>> =>
  sharedReadCredentials(env, STORE);

export const saveCredential = (env: PushEnv, origin: string, token: string): Promise<string> =>
  sharedSaveCredential(env, STORE, origin, token);

export { normalizeOrigin } from "@odu/credentials";

export { describeFailure } from "./failure";

export interface ResolvedBucket {
  origin: string;
  name: string;
}

/**
 * A full URL names its own origin, and a bare name is resolved against the
 * origin this machine has logged in to — or, when it has logged in to none,
 * `$ODU_WEB_ORIGIN`.
 */
export async function resolveBucket(
  env: PushEnv,
  argument: string,
  /** `--origin`, which BEATS everything stored. */
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

export interface DescribedCache {
  origin: string;
  bucket: string;
}

const CACHE_INFO_MAX_BYTES = 8 * 1024;

const ERROR_BODY_MAX_BYTES = 4 * 1024;

async function boundedText(response: Response, limit: number): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let held = 0;
  try {
    while (held < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = value.subarray(0, limit - held);
      chunks.push(take);
      held += take.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(held);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(joined);
}

export async function describeCache(
  substituter: string,
  send: typeof fetch = fetch,
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
      `${url} could not be read (${describeFailure(err)}) — ` +
        `--cache takes the substituter URL your nix.conf uses, and this one did not answer`,
    );
  }
  if (!response.ok) {
    const why =
      token === null
        ? "and no token was sent — a PRIVATE bucket answers its nix-cache-info to " +
          "nobody. Set $ODU_CACHE_TOKEN (or --token-file), or check the URL"
        : "for the token this machine holds — check the URL, and that the token " +
          "may read this bucket";
    const said = await readBody(response);
    throw new Error(
      `${url} answered ${response.status} ${why}${said === "" ? "" : ` — it said: ${said}`}`,
    );
  }
  const text = await boundedText(response, CACHE_INFO_MAX_BYTES);
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
    origin = substituter;
  }
  return resolveToken(env, origin, tokenFile);
}

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

/**
 * Nix accepts both spellings for every multi-valued setting, and a repository
 * that writes `extra-substituters = "a b"` means the same two caches as one
 * that writes a list of two.
 */
export interface FlakeNixConfig {
  /** `substituters` ∪ `extra-substituters`, in declaration order. */
  substituters: readonly string[];
  /** `trusted-public-keys` ∪ `extra-trusted-public-keys`. */
  trustedPublicKeys: readonly string[];
}

export type FlakeNixConfigOutcome =
  | { ok: true; config: FlakeNixConfig }
  /** No `flake.nix`, or one `nix eval` would not read. */
  | { ok: false; reason: string };

export type NixEval = (
  dir: string,
) => Promise<{ ok: true; json: string } | { ok: false; stderr: string }>;

function settingWords(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(/\s+/).filter((word) => word !== "");
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => (typeof item === "string" ? settingWords(item) : []));
  }
  return [];
}

function unioned(config: Record<string, unknown>, plain: string): string[] {
  const out: string[] = [];
  for (const key of [plain, `extra-${plain}`]) {
    for (const word of settingWords(config[key])) {
      if (!out.includes(word)) out.push(word);
    }
  }
  return out;
}

export const FLAKE_EVAL_TIMEOUT_MS = 20_000;

const FLAKE_EVAL_MAX_STDOUT = 64 * 1024;

export const FLAKE_EVAL_MAX_STDERR = 512;

/**
 * `flake.nix` is the least trusted input odu has, and this is the one place a
 * repository's own expressions execute ON THE SERVICE. Four things bound it,
 * and each closes a specific hole:
 *
 *   - **an explicit, minimal environment.** The daemon's own environment is
 *     where `$ODU_ROOT_TOKEN` lives, and `builtins.getEnv` would have read it
 *     into a published skip reason. Nothing of this process's environment is
 *     inherited; `HOME` and `TMPDIR` are a scratch directory, `NIX_PATH` is
 *     empty, and the only variables forwarded are the ones that LOCATE a Nix
 *     store.
 *   - **`restrict-eval`**, with the checkout as the single search path. This
 *     is what stops `builtins.readFile /etc/shadow`, `builtins.fetchurl` and
 *     every other reach outside the repository — and, as a side effect Nix
 *     documents, makes `getEnv` answer `""` whatever the environment holds.
 *   - **`allow-import-from-derivation false`**, so an evaluation cannot
 *     become a BUILD on the service host.
 *   - **a process-group kill on the deadline**, because `nix` forks and
 *     killing the direct child alone leaves the evaluation running.
 *
 * `pure-eval` is explicitly OFF: it is incompatible with reading a file by
 * path at all, which is the whole operation. `restrict-eval` is what carries
 * the containment, and `--extra-experimental-features nix-command` is passed
 * because the synthetic `HOME` means a single-user install's own `nix.conf`
 * is not read.
 */
export function nixEvalFlakeConfig(parentEnv: NodeJS.ProcessEnv): NixEval {
  return async (dir) => {
    const scratch = mkdtempSync(join(tmpdir(), "odu-nixconfig-"));
    try {
      return await runNixEval(dir, scratch, parentEnv);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
}

async function runNixEval(
  dir: string,
  scratch: string,
  parentEnv: NodeJS.ProcessEnv,
): Promise<{ ok: true; json: string } | { ok: false; stderr: string }> {
  const child = spawn(
    "nix",
    [
      "eval",
      "--json",
      "--extra-experimental-features",
      "nix-command",
      "--option",
      "restrict-eval",
      "true",
      "--option",
      "pure-eval",
      "false",
      "--option",
      "allow-import-from-derivation",
      "false",
      "-I",
      `src=${dir}`,
      "--expr",
      "(import <src/flake.nix>).nixConfig",
    ],
    {
      cwd: scratch,
      // DETACHED so the deadline can take the whole group: `nix` forks, and a
      // kill aimed at the direct child leaves the evaluation burning a core.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: minimalNixEnv(scratch, parentEnv),
    },
  );
  const { promise, resolve } = Promise.withResolvers<
    { ok: true; json: string } | { ok: false; stderr: string }
  >();
  let out = "";
  let err = "";
  let timedOut = false;
  child.stdout?.setEncoding("utf-8");
  child.stderr?.setEncoding("utf-8");
  child.stdout?.on("data", (chunk: string) => {
    if (out.length < FLAKE_EVAL_MAX_STDOUT) out += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    if (err.length < FLAKE_EVAL_MAX_STDERR * 2) err += chunk;
  });
  const deadline = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid);
  }, FLAKE_EVAL_TIMEOUT_MS);
  deadline.unref?.();
  const finish = (outcome: { ok: true; json: string } | { ok: false; stderr: string }): void => {
    clearTimeout(deadline);
    resolve(outcome);
  };
  child.on("error", (error) =>
    finish({ ok: false, stderr: error instanceof Error ? error.message : String(error) }),
  );
  child.on("close", (code) => {
    if (timedOut) {
      finish({ ok: false, stderr: `nix eval did not finish within ${FLAKE_EVAL_TIMEOUT_MS}ms` });
      return;
    }
    if (code === 0) {
      finish({ ok: true, json: out });
      return;
    }
    finish({ ok: false, stderr: lastLine(err) });
  });
  return promise;
}

function minimalNixEnv(scratch: string, parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: parentEnv.PATH ?? "/usr/bin:/bin",
    HOME: scratch,
    TMPDIR: scratch,
    NIX_PATH: "",
  };
  for (const key of ["NIX_REMOTE", "NIX_STORE_DIR", "NIX_STATE_DIR"]) {
    const value = parentEnv[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  return env;
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
  }
}

export function lastLine(text: string): string {
  const lines = text.trim().split("\n").filter((line) => line.trim() !== "");
  const said = lines[lines.length - 1]?.trim() ?? "nix eval failed";
  return said.length <= FLAKE_EVAL_MAX_STDERR
    ? said
    : `${said.slice(0, FLAKE_EVAL_MAX_STDERR)}… (truncated)`;
}

export async function readFlakeNixConfig(
  dir: string,
  evaluate: NixEval,
): Promise<FlakeNixConfigOutcome> {
  if (!existsSync(join(dir, "flake.nix"))) {
    return { ok: false, reason: "no flake.nix" };
  }
  const evaluated = await evaluate(dir);
  if (!evaluated.ok) {
    return { ok: false, reason: `could not read nixConfig: ${evaluated.stderr}` };
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

export interface OduSubstituter extends DescribedCache {
  substituter: string;
}

export const CACHE_PROBE_TIMEOUT_MS = 5_000;

export const CACHE_PROBE_MAX = 8;

/**
 * `http`/`https` only — Bun's `fetch` serves `file:` URLs, and a repository
 * naming one would be reading the pusher's disk.
 */
export async function oduCachesOf(
  substituters: readonly string[],
  options: {
    send?: typeof fetch;
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
    send(input, {
      ...(init ?? {}),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    })) as typeof fetch;
  const dialable = substituters
    .filter((substituter) => /^https?:\/\//i.test(substituter.trim()))
    .slice(0, CACHE_PROBE_MAX);
  const described = await Promise.all(
    dialable.map(async (substituter) => {
      try {
        const facts = await describeCache(substituter, bounded, options.token ?? null);
        return { substituter, ...facts };
      } catch {
        return null;
      }
    }),
  );
  return described.filter((one): one is OduSubstituter => one !== null);
}

/**
 * The token, in the order the docs promise: `--token-file`, then
 * `$ODU_CACHE_TOKEN`, then the credentials entry for the bucket's origin.
 */
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
  return savedCredentialFor(env, origin);
}

export async function savedCredentialFor(
  env: PushEnv,
  origin: string,
): Promise<string | null> {
  const entries = await readCredentials(env);
  return entries[normalizeOrigin(origin)] ?? null;
}

export type ClosureEntry = PathInfo;

export interface PushRefusal {
  message: string;
  url: string | null;
  /** The status that came back; null when nothing did. */
  status: number | null;
  /** The server's own words, bounded; null when nothing answered. */
  body: string | null;
}

export interface PushFailure {
  path: string;
  message: string;
  /** One per attempt, in the order they were made; the last gave up. */
  attempts: readonly PushRefusal[];
}

export interface PushSummary {
  pushed: number;
  /**
   * The NAR size of every path it uploaded, summed. The UNCOMPRESSED size,
   * which is what the closure states and what a reader comparing it with
   * `nix path-info -S` expects. Zero when nothing was uploaded, a closure the
   * bucket already held included.
   */
  bytes: number;
  /** Paths the bucket already has, or would not take because an upstream key
   *  signed them. */
  skippedUpstream: number;
  /** Derivations the caller named. */
  skippedDerivation: readonly string[];
  /**
   * `direct` when the bucket's store took them itself through presigned URLs,
   * `staged` when they crossed the daemon, `null` when this push uploaded
   * nothing.
   */
  mode: UploadMode | null;
  alreadyPresent: number;
  failed: number;
  /** One entry per failure, with everything every attempt said — the URL, the
   *  status, the cause chain. */
  failures: readonly PushFailure[];
  /** What the bucket serves now, by name: everything in the closure it already
   *  had, plus everything this push stored. A caller that promises "every
   *  pushed path answers" checks THIS list, not the closure — the closure also
   *  holds the upstream-signed paths the bucket refuses by design and the paths
   *  whose upload was refused. */
  served: readonly string[];
  /** The address a Nix client substitutes it from — the bucket's own domain
   *  when it has one, else the mount path. Read from the bucket, not assembled
   *  here: only the daemon knows whether a name stands in front. */
  substituter: string;
  /** The pin this push re-pointed: its name and how many paths the closure it
   *  now holds has. Null when none was. */
  pinned: { name: string; rootPaths: number } | null;
  /** The daemon that answered. */
  pageUrl: string;
}

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
  /**
   * Supplying it skips {@link resolveToken} entirely.
   *
   * `null` is EXPLICIT: push anonymously, and let the bucket's own refusal be
   * the answer.
   */
  credential?: string | null;
  tokenFile?: string;
  /** Uploads in flight WITHIN one dependency depth. */
  concurrency?: number;
  /**
   * A NAR bigger than this is sent in parts, each retried on its own. The
   * default is under Cloudflare's 100 MB proxied-body cap; the server's
   * ceiling is {@link MAX_NAR_PART_BYTES}.
   */
  partSize?: number;
  /** Attempts per path. */
  attempts?: number;
  /**
   * Re-point this pin at what was pushed, by name. It runs AFTER the uploads
   * and only when every one of them landed. The bucket resolves the closure
   * itself from the roots named here.
   */
  pin?: string;
  /**
   * Store the whole closure, upstream-signed paths included. Absent or `false`
   * keeps the bucket's own rule: what an upstream key signed stays upstream.
   */
  whole?: boolean;
  /**
   * The run that produced these paths and the commit they were built from.
   * Pass what the caller has, empty or absent included.
   */
  run?: string;
  commit?: string;
  onLine?: (line: string) => void;
  platform?: PushPlatform;
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_ATTEMPTS = 3;

function worthRetrying(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function pushToCache(options: PushOptions): Promise<PushSummary> {
  const say = options.onLine ?? (() => {});
  const resolved = await resolveBucket(options.env, options.bucket, options.origin);
  if ("error" in resolved) throw new Error(resolved.error);
  const token =
    options.credential === undefined
      ? await resolveToken(options.env, resolved.origin, options.tokenFile)
      : options.credential;
  if (token === null && options.credential === undefined) {
    throw new Error(
      `no token for ${resolved.origin} — pass --token-file, set $ODU_CACHE_TOKEN, ` +
        `or run \`odu cache login ${resolved.origin}\``,
    );
  }
  const base = `${resolved.origin}${CACHE_MOUNT}/${resolved.name}`;
  const headers: Record<string, string> =
    token === null ? {} : { authorization: `Bearer ${token}` };
  const provenance = provenanceHeaders({ run: options.run, commit: options.commit });

  const platform: PushPlatform = options.platform ?? {
    closure: (paths) => nixClosure(paths, null),
    dump: (storePath) => nixDump(storePath, null),
  };
  const skippedDerivation = options.paths.filter(isDerivationPath);
  for (const path of skippedDerivation) say(`⏭ ${path} skipped-derivation`);
  const uploadable = options.paths.filter((path) => !isDerivationPath(path));
  const closure =
    uploadable.length === 0
      ? new Map()
      : new Map((await platform.closure(uploadable)).map((info) => [info.storePath, info]));
  const answer =
    closure.size === 0
      ? {
          missing: [] as readonly string[],
          skippedUpstream: [] as readonly string[],
          substituter: null,
        }
      : await askMissing(resolved, { ...headers, ...provenance }, closure, options.whole === true);
  const present = closure.size - answer.missing.length;
  const alreadyPresent = present - answer.skippedUpstream.length;
  say(
    `${closure.size} paths in the closure: ${answer.missing.length} to push, ` +
      `${alreadyPresent} already here, ${answer.skippedUpstream.length} upstream`,
  );

  const failures: PushFailure[] = [];
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const width = options.concurrency ?? DEFAULT_CONCURRENCY;
  const partSize = options.partSize ?? DEFAULT_NAR_PART_BYTES;
  if (!Number.isSafeInteger(partSize) || partSize < 1 || partSize > MAX_NAR_PART_BYTES) {
    throw new Error(
      `a part must be between 1 and ${MAX_NAR_PART_BYTES} bytes (got ${partSize})`,
    );
  }
  let pushed = 0;
  let bytes = 0;
  let mode: UploadMode | null = null;

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
          provenance,
        });
        if (outcome.ok) {
          pushed += 1;
          bytes += entry.narSize;
          mode = outcome.mode;
          say(`✅ ${storePath} stored`);
          continue;
        }
        const refusal = everyAttempt(outcome.attempts);
        failures.push({
          path: storePath,
          message: refusal.message,
          attempts: outcome.attempts,
        });
        say(`❌ ${storePath} refused: ${refusal.message}`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(width, queue.length)) }, worker));
  };

  for (const wave of orderByDepth(closure, new Set(answer.missing))) {
    await runWave(wave);
  }

  const board = resolved.origin;
  const refused = new Set(failures.map((failure) => failure.path));
  const upstream = new Set(answer.skippedUpstream);
  const served = [...closure.keys()].filter(
    (storePath) => !refused.has(storePath) && !upstream.has(storePath),
  );

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
    substituter: answer.substituter ?? base,
    pinned,
    pageUrl: `${board.replace(/\/$/, "")}/#/cache/${encodeURIComponent(resolved.name)}`,
  };
}

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
  substituter: string | null;
}

async function askMissing(
  bucket: ResolvedBucket,
  headers: Record<string, string>,
  closure: Map<string, ClosureEntry>,
  whole: boolean,
  only?: ReadonlySet<string>,
): Promise<MissingAnswer> {
  const sending = only === undefined
    ? [...closure.values()]
    : [...closure.values()].filter((entry) => only.has(entry.storePath));
  const url = `${bucket.origin}/_odu/v1/buckets/${bucket.name}/missing`;
  const dialed = await dial(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      paths: sending.map((entry) => ({
        path: entry.storePath,
        sigs: entry.sigs,
      })),
      ...(whole ? { whole: true } : {}),
    }),
  });
  if (!dialed.ok) throw new Error(dialed.refusal.message);
  const { response } = dialed;
  if (!response.ok) {
    const refusal = await refused(
      "the bucket refused the missing-paths query",
      "POST",
      url,
      response,
    );
    throw new Error(refusal.message);
  }
  const read = await readJson("POST", url, response);
  if (!read.ok) throw new Error(read.refusal.message);
  const body = read.body;
  if (body === null || typeof body !== "object" || !("missing" in body)) {
    throw new Error(`${url} answered the missing-paths query without a \`missing\` list`);
  }
  const missing = body.missing;
  if (!Array.isArray(missing)) throw new Error(`${url} answered a \`missing\` that is not a list`);
  const skipped = "skippedUpstream" in body && Array.isArray(body.skippedUpstream)
    ? body.skippedUpstream
    : [];
  const substituter =
    "substituter" in body && typeof body.substituter === "string" ? body.substituter : null;
  const answer = {
    missing: missing.filter((path): path is string => typeof path === "string"),
    skippedUpstream: skipped.filter((path): path is string => typeof path === "string"),
    substituter,
  };
  if (whole && answer.skippedUpstream.length > 0) {
    throw new Error(
      `${url} skipped ${answer.skippedUpstream.length} upstream-signed paths on a whole push: ` +
        `it predates ${WHOLE_PUSH_SINCE}, which added whole pushes — upgrade the cache`,
    );
  }
  return answer;
}

async function pinClosure(
  bucket: ResolvedBucket,
  headers: Record<string, string>,
  name: string,
  served: readonly string[],
  say: (line: string) => void,
): Promise<{ name: string; rootPaths: number }> {
  const url = `${bucket.origin}/_odu/v1/buckets/${bucket.name}/pin`;
  const dialed = await dial(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name, paths: served }),
  });
  if (!dialed.ok) throw new Error(dialed.refusal.message);
  const { response } = dialed;
  if (!response.ok) {
    const refusal = await refused(`the bucket refused the pin "${name}"`, "POST", url, response);
    throw new Error(refusal.message);
  }
  const read = await readJson("POST", url, response);
  if (!read.ok) throw new Error(read.refusal.message);
  const body = read.body;
  if (
    body === null ||
    typeof body !== "object" ||
    !("rootPaths" in body) ||
    !Array.isArray(body.rootPaths)
  ) {
    throw new Error(`${url} answered the pin "${name}" without a \`rootPaths\` list`);
  }
  const rootPaths = body.rootPaths.length;
  say(`📌 ${name} now holds ${rootPaths} paths`);
  return { name, rootPaths };
}

type Dialed = { ok: true; response: Response } | { ok: false; refusal: PushRefusal };

async function dial(url: string, init: RequestInit = {}): Promise<Dialed> {
  try {
    return { ok: true, response: await fetch(url, init) };
  } catch (err) {
    return { ok: false, refusal: unreachable(init.method ?? "GET", url, err) };
  }
}

function unreachable(method: string, url: string, err: unknown): PushRefusal {
  return {
    message: `${method} ${url} could not be reached: ${describeFailure(err)}`,
    url,
    status: null,
    body: null,
  };
}

async function readBody(response: Response): Promise<string> {
  try {
    return (await boundedText(response, ERROR_BODY_MAX_BYTES)).trim();
  } catch (err) {
    return `the body could not be read: ${describeFailure(err)}`;
  }
}

async function refused(
  what: string,
  method: string,
  url: string,
  response: Response,
): Promise<PushRefusal> {
  const body = await readBody(response);
  return {
    message: `${what}: ${method} ${url} answered ${response.status}${body === "" ? "" : `: ${body}`}`,
    url,
    status: response.status,
    body: body === "" ? null : body,
  };
}

async function readJson(
  method: string,
  url: string,
  response: Response,
): Promise<{ ok: true; body: unknown } | { ok: false; refusal: PushRefusal }> {
  try {
    return { ok: true, body: await response.json() };
  } catch (err) {
    return {
      ok: false,
      refusal: {
        message:
          `${method} ${url} answered ${response.status} with a body this client ` +
          `could not read as JSON: ${describeFailure(err)}`,
        url,
        status: response.status,
        body: null,
      },
    };
  }
}

function everyAttempt(tried: readonly PushRefusal[]): PushRefusal {
  const last = tried.at(-1);
  if (last === undefined) {
    return { message: "no attempt was made", url: null, status: null, body: null };
  }
  if (tried.length === 1) return last;
  return {
    ...last,
    message: tried
      .map((one, at) => `attempt ${at + 1}/${tried.length}: ${one.message}`)
      .join(" · "),
  };
}

function retryLine(
  subject: string,
  attempt: number,
  attempts: number,
  because: PushRefusal,
): string {
  return `↻ ${subject} (attempt ${attempt + 1}/${attempts}) after ${because.message}`;
}

type UploadOutcome =
  | { ok: true; mode: UploadMode }
  | { ok: false; attempts: readonly PushRefusal[] };

type NarUpload =
  | { ok: true }
  | { ok: false; refusal: PushRefusal; retry: boolean };

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
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

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
): Promise<{ ok: true } | { ok: false; refusal: PushRefusal }> {
  const url = `${base}/nar/${narName}/parts/${index}`;
  const subject = `${storePath} part ${index + 1}`;
  const tried: PushRefusal[] = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const previous = tried.at(-1);
    if (previous !== undefined) say(retryLine(subject, attempt, attempts, previous));
    const dialed = await dial(url, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/x-nix-nar", [UPLOAD_SESSION_HEADER]: session },
      // Bun's fetch takes the bytes; the DOM `BodyInit` the type names does
      // not include this `Uint8Array` spelling.
      body: part as unknown as BodyInit,
    });
    if (!dialed.ok) {
      tried.push(dialed.refusal);
      continue;
    }
    const { response } = dialed;
    if (response.ok) return { ok: true };
    tried.push(await refused(`part ${index + 1} was refused`, "PUT", url, response));
    if (!worthRetrying(response.status)) break;
  }
  return { ok: false, refusal: everyAttempt(tried) };
}

async function beginUpload(
  base: string,
  headers: Record<string, string>,
  narName: string,
  partSize: number,
): Promise<UploadPlan | { refusal: PushRefusal; retry: boolean }> {
  const url = `${base}/nar/${narName}/upload`;
  const dialed = await dial(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ partSize }),
  });
  if (!dialed.ok) return { refusal: dialed.refusal, retry: true };
  const { response } = dialed;
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return {
      refusal: {
        message:
          `${url} does not take uploads this way: it predates cache surface ` +
          `${UPLOAD_NEGOTIATION_SINCE}, which added the upload negotiation — upgrade the cache`,
        url,
        status: 404,
        body: null,
      },
      retry: false,
    };
  }
  if (!response.ok) {
    return {
      refusal: await refused("beginning the upload", "POST", url, response),
      retry: worthRetrying(response.status),
    };
  }
  const read = await readJson("POST", url, response);
  if (!read.ok) return { refusal: read.refusal, retry: true };
  const body = read.body;
  const mode: unknown =
    body !== null && typeof body === "object" && "mode" in body ? body.mode : undefined;
  if (mode !== "direct" && mode !== "staged") {
    return {
      refusal: {
        message: `${url} answered an upload mode this client does not know: ${String(mode)}`,
        url,
        status: response.status,
        body: null,
      },
      retry: false,
    };
  }
  return body as UploadPlan;
}

/** One PART, PUT to the STORE. No odu header rides along: the URL carries
 *  its own authority, and an `Authorization` beside a presigned signature is
 *  what an S3 service refuses. */
async function putToStore(
  url: string,
  body: Uint8Array,
): Promise<{ ok: true; etag: string | null } | { ok: false; refusal: PushRefusal }> {
  const dialed = await dial(url, {
    method: "PUT",
    headers: { "content-length": String(body.length) },
    // Bun's fetch takes the bytes; the DOM `BodyInit` the type names does not
    // include this `Uint8Array` spelling.
    body: body as unknown as BodyInit,
  });
  if (!dialed.ok) return { ok: false, refusal: dialed.refusal };
  const { response } = dialed;
  if (!response.ok) {
    return {
      ok: false,
      refusal: await refused("the store refused a presigned PUT", "PUT", url, response),
    };
  }
  await response.body?.cancel().catch(() => {});
  return { ok: true, etag: response.headers.get("etag") };
}

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
    let url = plan.part;
    if (index > 0) {
      const signUrl = `${base}/nar/${narName}/upload/${plan.upload}/parts/${index}`;
      const dialed = await dial(signUrl, { headers });
      if (!dialed.ok) {
        await parts.return(undefined as never);
        return { ok: false, refusal: dialed.refusal, retry: true };
      }
      const signed = dialed.response;
      if (!signed.ok) {
        await parts.return(undefined as never);
        return {
          ok: false,
          refusal: await refused(`signing part ${index + 1}`, "GET", signUrl, signed),
          retry: signed.status === 404 || worthRetrying(signed.status),
        };
      }
      const read = await readJson("GET", signUrl, signed);
      if (!read.ok) {
        await parts.return(undefined as never);
        return { ok: false, refusal: read.refusal, retry: true };
      }
      const signedBody = read.body;
      const presigned =
        signedBody !== null &&
        typeof signedBody === "object" &&
        "url" in signedBody &&
        typeof signedBody.url === "string"
          ? signedBody.url
          : null;
      if (presigned === null) {
        await parts.return(undefined as never);
        return {
          ok: false,
          refusal: {
            message: `${signUrl} answered part ${index + 1}'s signature without a \`url\``,
            url: signUrl,
            status: signed.status,
            body: null,
          },
          retry: false,
        };
      }
      url = presigned;
    }
    const sent = await putToStore(url, current);
    if (!sent.ok) {
      await parts.return(undefined as never);
      return { ok: false, refusal: sent.refusal, retry: true };
    }
    if (sent.etag === null) {
      await parts.return(undefined as never);
      return {
        ok: false,
        refusal: {
          message: `${url} took part ${index + 1} without an ETag, which the join needs`,
          url,
          status: null,
          body: null,
        },
        retry: false,
      };
    }
    done.push({ index, etag: sent.etag });
    if (index > 0) say(`⏳ ${entry.storePath} part ${index + 1} → store`);
    if (ahead.done) break;
    current = ahead.value;
    ahead = await parts.next();
  }

  const joinUrl = `${base}/nar/${narName}/upload/${plan.upload}/complete`;
  const dialed = await dial(joinUrl, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ parts: done }),
  });
  if (!dialed.ok) return { ok: false, refusal: dialed.refusal, retry: true };
  const joined = dialed.response;
  if (!joined.ok) {
    return {
      ok: false,
      refusal: await refused("finishing the upload", "POST", joinUrl, joined),
      retry: true,
    };
  }
  await joined.body?.cancel().catch(() => {});
  return { ok: true };
}

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
    const url = `${base}/nar/${narName}`;
    const dialed = await dial(url, {
      method: "PUT",
      headers: { ...headers, "content-type": "application/x-nix-nar" },
      // Same spelling as the part upload: Bun takes the bytes.
      body: body as unknown as BodyInit,
    });
    if (!dialed.ok) return { ok: false, refusal: dialed.refusal, retry: true };
    const { response } = dialed;
    if (response.ok) return { ok: true };
    return {
      ok: false,
      refusal: await refused("nar upload", "PUT", url, response),
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
      return { ok: false, refusal: sent.refusal, retry: true };
    }
    say(`⏳ ${entry.storePath} part ${index + 1}`);
    index += 1;
    if (ahead.done) break;
    current = ahead.value;
    ahead = await parts.next();
  }

  const joinUrl = `${base}/nar/${narName}/complete`;
  const dialed = await dial(joinUrl, {
    method: "POST",
    headers: { ...headers, [PARTS_HEADER]: String(index), [UPLOAD_SESSION_HEADER]: session },
  });
  if (!dialed.ok) return { ok: false, refusal: dialed.refusal, retry: true };
  const joined = dialed.response;
  if (!joined.ok) {
    return {
      ok: false,
      refusal: await refused(`joining ${index} parts`, "POST", joinUrl, joined),
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
  options: {
    partSize: number;
    provenance: Record<string, string>;
  },
): Promise<UploadOutcome> {
  const tried: PushRefusal[] = [];

  const narName = `${narHashBase32(entry.narHash)}.nar.zst`;
  const session = randomUUID();
  let plan = await beginUpload(base, headers, narName, options.partSize);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const previous = tried.at(-1);
    if (previous !== undefined) {
      say(retryLine(entry.storePath, attempt, attempts, previous));
      if ("refusal" in plan || plan.mode === "direct") {
        plan = await beginUpload(base, headers, narName, options.partSize);
      }
    }
    if ("refusal" in plan) {
      tried.push(plan.refusal);
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
      tried.push(uploaded.refusal);
      if (!uploaded.retry) break;
      continue;
    }
    const infoUrl = `${base}/${storePathHash(entry.storePath)}.narinfo`;
    const dialed = await dial(infoUrl, {
      method: "PUT",
      headers: {
        ...headers,
        ...options.provenance,
        "content-type": "text/x-nix-narinfo",
      },
      body: formatPushNarinfo(entry, narName),
    });
    if (!dialed.ok) {
      tried.push(dialed.refusal);
      continue;
    }
    const infoResponse = dialed.response;
    if (infoResponse.status === 200) return { ok: true, mode: plan.mode };
    tried.push(await refused("narinfo upload", "PUT", infoUrl, infoResponse));
    if (infoResponse.ok || !worthRetrying(infoResponse.status)) break;
  }
  return { ok: false, attempts: tried };
}

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
