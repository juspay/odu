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

/**
 * WHY A PUSH FAILED, IN FULL — the cause chain, the platform's codes, the
 * address a dial was refused at. Re-exported from this client's own door so
 * that a caller reporting a push (a lane, the CLI, a run's node) has ONE
 * spelling of "all of it" and never has to settle for `err.message` again:
 * the message of a `fetch` rejection is "Unable to connect. Is the computer
 * able to access the url?", which names neither the url nor the reason.
 */
export { describeFailure } from "./failure";

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

/** How much of a `nix-cache-info` is worth reading. The real file is five
 *  short lines; the bound exists because the URL can come from a repository. */
const CACHE_INFO_MAX_BYTES = 8 * 1024;

/** How much of a REFUSAL is worth reading. Every message built from one of
 *  these becomes a line in a node's log and, through a failed push, a run's
 *  red verdict — and the server that wrote it is whatever address the push
 *  went to, which for an inferred target a repository chose. A sentence is a
 *  few hundred bytes; the rest is somebody filling this process's memory. */
const ERROR_BODY_MAX_BYTES = 4 * 1024;

/**
 * The first `limit` bytes of a response, READ AS THEY ARRIVE and then stopped.
 *
 * `(await response.text()).slice(limit)` is not a bound: it buffers whatever
 * the server sends and truncates afterwards, so a URL out of somebody's
 * `flake.nix` answering a gigabyte costs a gigabyte of this process's memory
 * before a single byte is discarded. Reading the stream lets the cancel
 * happen at the limit, which also closes the connection.
 *
 * Decoded as UTF-8 with no regard for a character split across the cut: this
 * reads `Key: value` ASCII lines, and the only cost of a mangled final rune
 * is a field that does not parse — on a body already eight kilobytes past
 * where a real `nix-cache-info` ended.
 */
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
    // CANCEL, not just release: a server still streaming must be hung up on
    // rather than left to fill a buffer nobody reads.
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
    // THE WHOLE CHAIN, not `err.message`: this is the first address a push
    // ever dials, so "could not be read" without a `code` is a reader's dead
    // end — a name that does not resolve, a port nothing listens on and a
    // certificate nobody trusts all reach here saying nothing of themselves.
    throw new Error(
      `${url} could not be read (${describeFailure(err)}) — ` +
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

/** How a `nix eval` is run. ASYNC, because this is reached from `run.start`
 *  on a daemon that is one event loop: a synchronous evaluation of somebody
 *  else's `flake.nix` froze the board, every projection and another run's
 *  in-flight upload for as long as `nix` took, and `nixConfig = let f = x: f
 *  x; in f 1` is how long that is. Injected so the resolver's arms — no
 *  flake, an eval error, a `nixConfig` of the wrong shape — are stated
 *  without a Nix. */
export type NixEval = (
  dir: string,
) => Promise<{ ok: true; json: string } | { ok: false; stderr: string }>;

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

/** How long a `nixConfig` evaluation may take. It fetches nothing and parses
 *  one file, so this is a backstop against a hostile or hung `nix`, not a
 *  budget — and it is enforced by killing the process GROUP, because `nix`
 *  forks. */
export const FLAKE_EVAL_TIMEOUT_MS = 20_000;

/** How much of a `nix eval` answer is worth reading. A `nixConfig` is a few
 *  hundred bytes; anything past this is a repository trying to make a parser
 *  the expensive part of a run. */
const FLAKE_EVAL_MAX_STDOUT = 64 * 1024;

/** How much of `nix`'s complaint survives into the run's record. The reason
 *  becomes an argv (`--push-note`), a durable manifest field and a line in a
 *  log, and a repository controls every byte of it. */
export const FLAKE_EVAL_MAX_STDERR = 512;

/**
 * `nixConfig`, EVALUATED UNDER RESTRAINT.
 *
 * `flake.nix` is the least trusted input odu has: on `odu ci run` over a
 * contributor's branch it is attacker-controlled, and this is the one place a
 * repository's own expressions execute ON THE SERVICE. Four things bound it,
 * and each closes a specific hole rather than being belt and braces:
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
    // Twice the published bound, so the LAST line is still whole when the
    // trace above it is long.
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

/** The whole environment a `nixConfig` evaluation gets, out of the one the
 *  composition root handed in. Nothing else of the daemon's: see
 *  {@link nixEvalFlakeConfig}. The three `NIX_*` names forwarded LOCATE a
 *  store (a daemon socket, a chroot store) and carry no credential. */
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

/** Kill a detached child's whole process group, best effort. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone, or never a group leader. Either way there is nothing to
    // stop and nothing a caller could do about it.
  }
}

/** THE LAST LINE of a `nix` complaint, which is where the fault is; the ones
 *  above it are the trace. Truncated, because every byte of it is the
 *  repository's and it becomes an argv and a durable field. */
export function lastLine(text: string): string {
  const lines = text.trim().split("\n").filter((line) => line.trim() !== "");
  const said = lines[lines.length - 1]?.trim() ?? "nix eval failed";
  return said.length <= FLAKE_EVAL_MAX_STDERR
    ? said
    : `${said.slice(0, FLAKE_EVAL_MAX_STDERR)}… (truncated)`;
}

/** What a checkout's `flake.nix` declares about the caches it reads from.
 *  The evaluation is an ARGUMENT: which `nix` runs, and in what environment
 *  it runs, is the composition root's fact — see {@link nixEvalFlakeConfig}. */
export async function readFlakeNixConfig(
  dir: string,
  evaluate: NixEval,
): Promise<FlakeNixConfigOutcome> {
  if (!existsSync(join(dir, "flake.nix"))) {
    return { ok: false, reason: "no flake.nix" };
  }
  const evaluated = await evaluate(dir);
  if (!evaluated.ok) {
    // "COULD NOT READ", not "your flake is wrong". A hung `nix`, a store that
    // is not there and an actual syntax error all land here, and only the
    // repository's own `nix` line can tell them apart — so the sentence says
    // what odu knows and quotes what nix said.
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

/** A substituter that answered as an odu cache — the URL asked, and the two
 *  lines it said about itself. */
export interface OduSubstituter extends DescribedCache {
  substituter: string;
}

/** How long one `nix-cache-info` probe may take. Bounded because a
 *  substituter that accepts a connection and never answers must cost a
 *  timeout rather than the command. */
export const CACHE_PROBE_TIMEOUT_MS = 5_000;

/** How many substituters are worth asking about. A repository that names more
 *  than this is not describing its cache. */
export const CACHE_PROBE_MAX = 8;

/**
 * WHICH OF THESE SUBSTITUTERS ARE ODU CACHES — asked of each one, in parallel,
 * with a bounded wait.
 *
 * A substituter that does not answer, or answers without `Odu-Origin` and
 * `Odu-Bucket`, is IGNORED rather than refused: `cache.nixos.org` is in a great
 * many `nixConfig`s and is nobody's push target.
 *
 * **The URL list comes from a repository, so the dial is bounded on every
 * axis.** `http`/`https` only — Bun's `fetch` serves `file:` URLs, and a
 * repository naming one would be reading the pusher's disk. Redirects are not
 * followed, because a 302 is a second URL nobody vetted. The list is capped
 * and so is the body: a `nix-cache-info` is under a kilobyte.
 *
 * This no longer runs on the SERVICE. A run's push target is decided from the
 * URL against what the daemon advertises (`CacheGrants.bucketAt`), which can
 * be neither lied to nor pointed at a machine of the attacker's choosing;
 * this is the CLIENT's discovery, where the person at the terminal is the one
 * whose machine dials.
 */
export async function oduCachesOf(
  substituters: readonly string[],
  options: {
    send?: typeof fetch;
    /** The credential a PRIVATE bucket's `nix-cache-info` needs. Omitted for
     *  an INFERRED substituter: the repository chose that URL, so a token the
     *  operator holds must not be sent to it. */
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
        // NOT AN ODU CACHE, or not reachable. Either way this is not the
        // repository's push target and saying so would be noise on every run
        // of every repo that substitutes from nixos.org.
        return null;
      }
    }),
  );
  return described.filter((one): one is OduSubstituter => one !== null);
}

/**
 * The token, in the order the docs promise: `--token-file`, then
 * `$ODU_CACHE_TOKEN`, then the credentials entry for the bucket's origin.
 *
 * The first two are ORIGIN-AGNOSTIC — a credential for whatever address this
 * push ends up at — so this is the order for an address the OPERATOR typed,
 * which is the only caller that reaches it by default. A caller whose address
 * came from somewhere else resolves its own and passes `credential`; see
 * {@link savedCredentialFor}.
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

/**
 * ONLY WHAT THIS MACHINE SAVED FOR THAT ORIGIN — `odu cache login`'s entry,
 * and nothing origin-agnostic.
 *
 * The credentials file is keyed by origin, so an entry in it is a decision
 * somebody made about that address. `--token-file` and `$ODU_CACHE_TOKEN` are
 * decisions about no address at all, which is exactly wrong when the address
 * came out of a repository: one `extra-substituters` line in a contributor's
 * `flake.nix` would otherwise collect `$ODU_CACHE_TOKEN` — a workflow secret,
 * on the spelling that is now the recommended one.
 */
export async function savedCredentialFor(
  env: PushEnv,
  origin: string,
): Promise<string | null> {
  const entries = await readCredentials(env);
  return entries[normalizeOrigin(origin)] ?? null;
}

/** The closure this client uploads. Named for what the caller means; the shape
 *  is the store's, and the parser behind it is the store's too — one answer to
 *  "what did `nix path-info` say", for the pusher and for a pin. */
export type ClosureEntry = PathInfo;

/**
 * WHY ONE REQUEST FAILED, AS A VALUE.
 *
 * A summary crosses a boundary — a lane serialises it, the board renders it —
 * so an `Error` may not ride on one: its `cause` chain, which is the whole
 * point, does not survive `JSON.stringify` and its stack is not a fact about
 * the push. Everything diagnostic is therefore flattened HERE, where the
 * request was made and the address is still known, rather than at the catch
 * site that has only a sentence left.
 *
 * `message` is the whole of it on one line. The other three are the same
 * facts as FIELDS, for a caller that wants to render the status apart from
 * the address: `url` is null only for a failure that was not a request,
 * `status` and `body` are null when nothing answered at all — which is
 * precisely the distinction between "the bucket refused this" and "the bucket
 * was never reached".
 */
export interface PushRefusal {
  /** What was attempted, where, and why it failed — one dense line. */
  message: string;
  /** The URL dialled. */
  url: string | null;
  /** The status that came back; null when nothing did. */
  status: number | null;
  /** The server's own words, bounded; null when nothing answered. */
  body: string | null;
}

/**
 * A PATH THAT DID NOT MAKE IT, AND EVERY ATTEMPT MADE ON IT.
 *
 * All of the attempts, not the last one: a path retried three times fails for
 * three reasons, and the interesting one is routinely the first — a 503 that
 * became a connection reset that became a timeout is a server going down,
 * which the last reason alone does not say.
 */
export interface PushFailure {
  path: string;
  /** Every attempt's reason, joined — the sentence to print when one is
   *  wanted. */
  message: string;
  /** One per attempt, in the order they were made; the last gave up. */
  attempts: readonly PushRefusal[];
}

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
  /** One entry per failure, with everything every attempt said — the URL, the
   *  status, the cause chain. A caller that wants a line prints `message`; a
   *  caller that wants fields reads `attempts`. */
  failures: readonly PushFailure[];
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
  /**
   * THE CREDENTIAL THIS PUSH IS AUTHORISED TO SEND, when the caller already
   * holds one — a lane with the run's write token, or a CLI that resolved
   * its own. Supplying it skips {@link resolveToken} entirely, which is why
   * a caller holding a token does not have to describe a machine it is not
   * on.
   *
   * `null` is EXPLICIT: push anonymously, and let the bucket's own refusal be
   * the answer. The CLI uses it for an inferred target with nothing saved for
   * that origin, where the alternative was sending the operator's
   * origin-agnostic secret to an address a `flake.nix` chose.
   */
  credential?: string | null;
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
  /**
   * WHAT BUILT THESE PATHS — the run that produced them and the commit they
   * were built from. Pass what the caller has, empty or absent included:
   * {@link provenanceHeaders} is what decides which of them was STATED, and a
   * re-push that states nothing must not erase what a run stated.
   */
  run?: string;
  commit?: string;
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
  // THE CALLER'S OWN CREDENTIAL WHEN IT HAS ONE, and the discovery order
  // otherwise. A lane holds the run's write token; a CLI that inferred its
  // target has already decided which credentials are in scope for an address
  // a repository chose. Neither should have to express that through an
  // environment it does not have.
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
  // WHAT BUILT THESE PATHS, as the headers the narinfo PUT carries — built
  // once, by the module that owns the wire. Nothing is tested here: a value
  // that is empty is a value nobody stated, which `provenanceHeaders` knows.
  const provenance = provenanceHeaders({ run: options.run, commit: options.commit });

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
      : // THE PROVENANCE RIDES HERE TOO, not only on the narinfo PUT: the
        // paths this answer calls present get no PUT at all, and this is the
        // one request that touches their rows. The bucket fills a null column
        // and overwrites none.
        await askMissing(resolved, { ...headers, ...provenance }, closure);
  const present = closure.size - answer.missing.length;
  const alreadyPresent = present - answer.skippedUpstream.length;
  // ONE PREAMBLE, then a line per path: what the closure is, what the bucket
  // already has, and what it will never take because an upstream key signed it.
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
  // THE FIRST REQUEST A PUSH MAKES, and therefore the one a misconfigured
  // origin dies on — which is why every throw below names the address. A bare
  // `fetch` rejection names neither the URL nor the reason.
  const url = `${bucket.origin}/_odu/v1/buckets/${bucket.name}/missing`;
  const dialed = await dial(url, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      paths: sending.map((entry) => ({
        path: entry.storePath,
        sigs: entry.sigs,
      })),
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
  // WHAT THE BUCKET SAYS IT HOLDS, never what this client sent: the closure
  // is resolved there, so its own roots are the only true count — and a
  // daemon that answered something else has not done what was asked.
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

/**
 * `fetch`, WITH THE ADDRESS IT DIALLED KEPT.
 *
 * A `fetch` rejection is a TypeError that names no URL — the client knows
 * which address it asked for and the error does not — and under it sits the
 * only interesting part, a `cause` carrying `ECONNREFUSED` or `ENOTFOUND` or
 * a certificate's expiry. Both are lost by the `.catch(asError)` this
 * replaced, and what reached a production log was the TypeError's sentence
 * alone: "Unable to connect. Is the computer able to access the url?"
 *
 * So NO SITE ON THE PUSH PATH CALLS `fetch` DIRECTLY. Every one dials through
 * here, and gets back a value that carries the address and the whole chain.
 */
type Dialed = { ok: true; response: Response } | { ok: false; refusal: PushRefusal };

async function dial(url: string, init: RequestInit = {}): Promise<Dialed> {
  try {
    return { ok: true, response: await fetch(url, init) };
  } catch (err) {
    return { ok: false, refusal: unreachable(init.method ?? "GET", url, err) };
  }
}

/** A request NOTHING ANSWERED: the method, the address, and every link of the
 *  reason. `status` and `body` are null because there was no response at all —
 *  which is the fact that distinguishes a dead address from a refusal. */
function unreachable(method: string, url: string, err: unknown): PushRefusal {
  return {
    message: `${method} ${url} could not be reached: ${describeFailure(err)}`,
    url,
    status: null,
    body: null,
  };
}

/** THE SERVER'S OWN WORDS, bounded — and, when the connection died while they
 *  were being read, why that failed instead. A refusal whose body could not be
 *  read is still a refusal, so this never throws. */
async function readBody(response: Response): Promise<string> {
  try {
    return (await boundedText(response, ERROR_BODY_MAX_BYTES)).trim();
  } catch (err) {
    return `the body could not be read: ${describeFailure(err)}`;
  }
}

/** A request that WAS answered, and refused. The status alone is a code; the
 *  body is where a cache says which token it wanted or which reference it is
 *  waiting for, so both are kept, and the address with them. */
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

/** A JSON body, or a refusal naming the address that answered bytes this
 *  client could not read. `response.json()` rejects with a parser's complaint
 *  about a character offset and nothing about who sent it — which, for an
 *  origin a `flake.nix` chose, is the only part that matters. */
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

/**
 * EVERY ATTEMPT'S REASON, AS ONE REFUSAL.
 *
 * A path retried three times failed three times, and keeping only the last is
 * how a server that went down reads as a timeout. The fields stay the LAST
 * attempt's — it is the one that gave up, and a caller rendering a status
 * wants the status that ended it — while the message carries all of them.
 */
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

/** THE ONE SHAPE A RETRY NARRATES WITH, wherever one is made: which attempt,
 *  of how many, and the WHOLE of what the previous one failed with — the URL
 *  and the cause chain included, since the retry line is the only place a
 *  recovered-from failure is ever said out loud. */
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
 *  server never has to know which attempt it is. Every attempt is narrated as
 *  it is made, and every attempt's reason survives into the refusal: a part
 *  that took three tries failed three times, and the first failure is usually
 *  the one that says what is actually wrong. */
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
    // THE PREVIOUS ATTEMPT'S REASON, said out loud before the next one is
    // made. Nothing else ever says it: a part that eventually lands leaves no
    // refusal behind, so a silent retry is a failure that happened and was
    // never reported.
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

/**
 * WHERE THIS NAR'S BYTES GO — asked once per path, before any are sent.
 *
 * The CACHE answers from the bucket's store, so there is no flag and no
 * probe: `direct` hands back URLs that write the store itself, `staged` means
 * the NAR route this client has always used. A 404 is an origin from before
 * the negotiation, and this client does NOT fall back — a store-backed bucket
 * would then silently go on pushing every byte through the daemon, which is
 * the thing 2.9 removes — so it says which version it needs and stops.
 *
 * THE `say` SINK IS NOT HERE, deliberately: this makes ONE request and knows
 * neither which attempt it is nor how many are allowed. Its refusal goes back
 * as a value to {@link uploadOne}, which owns the attempt count and narrates
 * every retried attempt — a begin that failed and was tried again included,
 * which is exactly what no log used to show.
 */
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
    // THE CLIENT'S `--part-size`, as a FLOOR: in direct mode there is no
    // proxy body limit to stay under, and the server raises it to what S3
    // and the store demand.
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
  // THE WORD THE SERVER ACTUALLY SENT, read by narrowing rather than through
  // the plan's own type: once `plan.mode` has been excluded of both known
  // modes it is `never`, and the one fact worth reporting — what it said
  // instead — is no longer spellable through it.
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
  // The mode is proven; the rest of the plan is the negotiated contract's,
  // and the caller reads it under that contract's types.
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
          // THIS IS ODU ANSWERING, not the store, so the shared rule decides
          // — plus the one status whose meaning odu defines here: a `404` is
          // an upload this daemon no longer holds, and beginning again is
          // exactly its answer. A `403` is a token that will not improve.
          retry: signed.status === 404 || worthRetrying(signed.status),
        };
      }
      const read = await readJson("GET", signUrl, signed);
      if (!read.ok) {
        await parts.return(undefined as never);
        return { ok: false, refusal: read.refusal, retry: true };
      }
      // A PRESIGN THAT IS NOT A STRING is a daemon answering something this
      // client cannot dial, and PUTting to `undefined` would fail one layer
      // down with an address nobody recognises. Say what was asked and what
      // came back instead.
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
        // A 2xx WITH NOTHING IN IT: the store took the bytes and named no
        // ETag, so there is no status to report that would not read as a
        // refusal it never made — the address is the whole of the evidence.
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
    // PROGRESS for a large path: one line per part, so a slow upload reads
    // as work rather than as the old silence.
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
    // EVERY REFUSAL HERE RE-BEGINS THE PATH. The upload this one names is
    // finished with either way — odu drops it on a refusal — and the reachable
    // causes are not the client's to correct in place: a store that would not
    // join the parts, an object that never landed, an id this daemon no longer
    // holds. A new upload id is the only answer any of them has, and the
    // attempt budget bounds it.
    return {
      ok: false,
      refusal: await refused("finishing the upload", "POST", joinUrl, joined),
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
    // THE BODY, which this arm alone used to throw away — and it is the arm
    // every small path takes, so the commonest refusal in the whole client
    // was the one that said least.
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
    // PROGRESS for a large path: one line per part, so a slow upload reads as
    // work rather than as the old silence.
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

/**
 * ONE PATH, UP TO `attempts` TIMES — and every attempt is kept.
 *
 * This is the loop that owns the attempt count, so it is the loop that
 * NARRATES: before each retried attempt it says which attempt is about to be
 * made, of how many, and the whole of what the previous one failed with — the
 * URL and the cause chain included. A path that eventually lands otherwise
 * leaves no trace of the failures it survived, and a path that does not land
 * used to report only the last of them, which is how a server going down read
 * as a single timeout.
 */
async function uploadOne(
  base: string,
  headers: Record<string, string>,
  entry: ClosureEntry,
  platform: PushPlatform,
  attempts: number,
  say: (line: string) => void,
  options: {
    partSize: number;
    /** What {@link provenanceHeaders} made of the caller's stated run and
     *  commit — empty when it stated neither. */
    provenance: Record<string, string>;
  },
): Promise<UploadOutcome> {
  /** Every attempt's reason, in order — the whole of what is reported when
   *  the budget runs out. */
  const tried: PushRefusal[] = [];

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
      // THE NARINFO PUT IS THE REQUEST THAT WRITES THE ROW, so it is the one
      // that carries what built the path. The body stays the Nix format
      // every client parses; odu's own facts ride above it.
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
    // 200 IS STORED, and it is the only answer that is. Any other status —
    // a success code this pusher does not know included — is a refusal like any
    // other, said with the server's own words and not repeated.
    if (infoResponse.status === 200) return { ok: true, mode: plan.mode };
    tried.push(await refused("narinfo upload", "PUT", infoUrl, infoResponse));
    if (infoResponse.ok || !worthRetrying(infoResponse.status)) break;
  }
  return { ok: false, attempts: tried };
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
