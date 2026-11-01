/**
 * `odu cache` — the bucket commands, in the package that owns the buckets.
 *
 * Two kinds of client in one command, and the split is the interesting part:
 *
 *   - **administration** (`create`, `list`, `use`, `token`, `pin`, `gc`,
 *     `stats`) is a client of the cache's own surface — the row served beside
 *     the runs on the same daemon. The buckets, their keys and their tokens
 *     live in the cache's database, and this module reaches them through the
 *     row's contract rather than through `@odu/service`'s.
 *   - **`push` and `login`** are clients of the cache's HTTP API, from the
 *     machine that holds the paths. They import `./push` and nothing else —
 *     no service, no catalog, no engine — which is the argument
 *     `@odu/cli`'s `authority.test.ts` makes for why they are admissible under
 *     a wall that forbids every public client the engine.
 *
 * ## The dial is a PORT, bound by the root
 *
 * This module is a FACE, and a face dials the daemon. The bootstrap — "start
 * one if nothing is serving" — belongs to `@odu/host`, and a ROW never names the
 * host: that is the arrow backwards. So the root binds a `connect` here
 * (`src/main.ts`), and the same `SurfaceDispatch` the ci client is built over
 * gives this face its CACHE client — one connection, two views, which is what
 * `ServiceConnection.dispatch` is published for.
 *
 * The root token comes from `$ODU_ROOT_TOKEN` and is passed straight through:
 * the CLI does not decide who may administer a bucket, and neither does the
 * service — the cache does, because it is the one that holds the secret.
 */

import { parseArgs } from "node:util";
import { buildSurfaceFace } from "@kolu/surface/client";
import type { SurfaceClientOf } from "@kolu/surface/project";
import { composedClients } from "@odu/cordis/compose";
import { readDoor } from "@odu/cordis/services";
import { bytes } from "@odu/cordis/format";
import type { SurfaceDispatch } from "@kolu/surface/link";
import { Effect } from "effect";
import { CACHE_MOUNT } from "./paths";
import { normalizeOrigin, pushToCache, saveCredential } from "./push";
import {
  CACHE_KEY,
  type CacheScope,
  type CacheToken,
  CacheRefused,
  oduCacheSurface,
  useBlock,
} from "./surface";

/** THE CACHE'S CLIENT, over a dispatch the caller already holds. One
 *  connection to the daemon serves every row; this is the cache's typed view of
 *  it, minted through the framework's own sibling composition so the tags it
 *  addresses are the ones the sibling is mounted at. */
export type CacheClient = SurfaceClientOf<(typeof oduCacheSurface)["spec"]>;

function cacheClientOver(dispatch: SurfaceDispatch): CacheClient {
  // The SIBLING, not the surface: `composeSurfaceContracts` re-walks the spec
  // with the `surface/cache/` prefix, and the face is built over the same
  // dispatch the ci client is, so one connection answers both.
  // ONE builder for every sibling client in the tree (`@odu/service-client`'s
  // `./compose`), so this face addresses the tags the daemon mounts the row at
  // without a second derivation of the prefix.
  return composedClients(
    { [CACHE_KEY]: oduCacheSurface },
    dispatch,
  ).cache as unknown as CacheClient;
}

/** What the root hands this face: the way in, and nothing else. */
export interface CacheCliPorts {
  /** Reach the daemon — starting it when nothing is serving and the origin is
   *  this install's own. Bound at the composition root, because the bootstrap is
   *  `@odu/host`'s and a row never names the host. */
  connect(origin: string | undefined): Promise<{
    dispatch: SurfaceDispatch;
    dispose: () => Promise<void>;
  }>;
}

export const CACHE_USAGE = `usage: odu cache <create|list|use|domain|token|login|push|pin|gc|stats> [args]

create <bucket> [--private] [--retention-days N] [--upstream-key K]… | --no-upstream
                              create a bucket; print its substituter URL and
                              public key. Needs $ODU_ROOT_TOKEN.
                              --no-upstream takes everything: for a server whose
                              store is not the machine that built the paths
list [-o json]                buckets, with sizes. Needs $ODU_ROOT_TOKEN
use <bucket>                  the nix.conf settings, the nixConfig block and the
                              netrc lines for a bucket. Needs NO token: a
                              bucket's URL and public key are public
domain <bucket> <name>|--none give a bucket a DNS name of its own (the
                              substituter URL becomes that name), or take it
                              away. Needs $ODU_ROOT_TOKEN
token mint <bucket> [--read|--write|--admin] [--expires-days N|--no-expiry] [--buckets GLOB]
                              mint a token. It is printed ONCE; only its hash
                              is kept. Expires in 90 days unless --expires-days
                              says otherwise; --no-expiry is the explicit never
token list [bucket] [-o json] tokens with scope, expiry and last use
token revoke <id>             revoke one token, without touching the rest
login <origin> [--token T]    save a token for an origin in
                              ~/.config/odu/cache/credentials (0600)
push <bucket> <path>… [--token-file F] [--concurrency N] [--part-size MiB] [-o json]
                              upload only the paths the bucket is missing.
                              Talks to the cache directly, from HERE. A NAR
                              larger than --part-size (64 MiB) is sent in parts,
                              each retried on its own. The bucket keeps what it
                              takes; there is no hold to wait for
pin <bucket> <name> <path>…   pin a closure against garbage collection
gc [bucket] [-o json]         evict what retention expired and nothing holds
stats [-o json]               storage and reads

--origin URL is accepted by every admin command (default $ODU_WEB_ORIGIN or
http://127.0.0.1:18440), and by \`push\`, where it BEATS a stored credential - a
machine logged in to one cache can still push to a second.

Token resolution for \`push\`: --token-file, then $ODU_CACHE_TOKEN, then the
credentials entry for the bucket's origin.
`;

/** What every admin command exits with when the service refuses it: 1. The
 *  run-shaped table in `serviceFace` numbers the states of a RUN, and a bucket
 *  is not one. */
const REFUSED = 1;

const rootToken = (): string => process.env.ODU_ROOT_TOKEN ?? "";

const scopeOf = (values: {
  read?: boolean;
  write?: boolean;
  admin?: boolean;
}): CacheScope => (values.admin === true ? "admin" : values.read === true ? "read" : "write");


// ── the face's plumbing ─────────────────────────────────────────────────────

/** Reach the daemon and hand the caller the cache's client, or report that
 *  nothing is serving and exit. */
async function withService(
  ports: CacheCliPorts,
  origin: string | undefined,
  use: (client: CacheClient) => Promise<number>,
): Promise<number> {
  let connection: Awaited<ReturnType<CacheCliPorts["connect"]>>;
  try {
    connection = await ports.connect(origin);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return REFUSED;
  }
  try {
    return await use(cacheClientOver(connection.dispatch));
  } finally {
    await connection.dispose();
  }
}

/** One procedure call, keeping the cache's REFUSAL apart from a dead link. */
async function call<A>(
  effect: Effect.Effect<A, unknown>,
): Promise<
  | { ok: true; value: A }
  | { ok: false; refusal: CacheRefused }
  | { ok: false; refusal: null; error: unknown }
> {
  const outcome = await Effect.runPromise(Effect.result(effect));
  if (outcome._tag === "Success") return { ok: true, value: outcome.success };
  const failure = outcome.failure;
  return failure instanceof CacheRefused
    ? { ok: false, refusal: failure }
    : { ok: false, refusal: null, error: failure };
}

/** A refusal, or a failed call, as the exit code and the sentence a person
 *  reads. */
function reportFailure(
  answer: { refusal: CacheRefused | null; error?: unknown },
  json: boolean,
  code: number,
): number {
  const message =
    answer.refusal !== null
      ? `odu: ${answer.refusal.message}`
      : `odu: the call did not complete — ${String(answer.error)}`;
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        answer.refusal === null
          ? { ok: false, error: message }
          : { ok: false, code: answer.refusal.code, message: answer.refusal.message },
        null,
        2,
      )}\n`,
    );
    return code;
  }
  process.stderr.write(`${message}\n`);
  return code;
}

function emitJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** A flag's whole-number value, or a usage error naming the flag. `Number("")`
 *  is 0 and `Number(" 5 ")` is 5, so a bare `Number` would read a truncated
 *  `--retention-days=` as "keep nothing" — which on a cache is a destructive
 *  reading of a typo. */
function wholeNumber(flag: string, raw: string): number {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`odu: ${flag} needs a whole number (got "${raw}")`);
  }
  return Number(trimmed);
}

const originOption = { type: "string" } as const;
const outputOption = { type: "string", short: "o" } as const;

export async function cacheCommand(
  sub: string | undefined,
  rest: string[],
  ports: CacheCliPorts,
): Promise<number> {
  switch (sub) {
    case "create":
      return createCommand(rest, ports);
    case "list":
      return listCommand(rest, ports);
    case "use":
      return useCommand(rest, ports);
    case "domain":
      return domainCommand(rest, ports);
    case "token":
      return tokenCommand(rest, ports);
    case "login":
      return loginCommand(rest);
    case "push":
      return pushCommand(rest);
    case "pin":
      return pinCommand(rest, ports);
    case "gc":
      return gcCommand(rest, ports);
    case "stats":
      return statsCommand(rest, ports);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(CACHE_USAGE);
      return sub === undefined ? 1 : 0;
    default:
      process.stderr.write(`odu: unknown cache sub-command "${sub}"\n${CACHE_USAGE}`);
      return 1;
  }
}

async function createCommand(rest: string[], ports: CacheCliPorts): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      private: { type: "boolean" },
      "retention-days": { type: "string" },
      "upstream-key": { type: "string", multiple: true },
      "no-upstream": { type: "boolean" },
      origin: originOption,
      output: outputOption,
    },
  });
  const name = positionals[0];
  if (name === undefined) {
    process.stderr.write(`odu: cache create needs a bucket name\n${CACHE_USAGE}`);
    return 1;
  }
  const json = values.output === "json";
  const upstream = values["upstream-key"];
  // BOTH is a contradiction with a one-sentence answer, not a merge rule: "take
  // nothing from upstream" and "take what these names signed" cannot both hold.
  if (values["no-upstream"] === true && upstream !== undefined) {
    process.stderr.write(
      "odu: --no-upstream and --upstream-key are opposites — a bucket either " +
        "takes paths an upstream key signed or it takes everything\n",
    );
    return 1;
  }
  const upstreamKeys = values["no-upstream"] === true ? [] : upstream;
  return withService(ports, values.origin, async (client) => {
    const answer = await call(
      client.surface.bucket.create({
        rootToken: rootToken(),
        name,
        public: values.private !== true,
        retentionDays:
          values["retention-days"] === undefined
            ? 90
            : wholeNumber("--retention-days", values["retention-days"]),
        ...(upstreamKeys === undefined ? {} : { upstreamKeys }),
      }),
    );
    if (!answer.ok) return reportFailure(answer, json, REFUSED);
    const bucket = answer.value;
    if (json) {
      emitJson(bucket);
      return 0;
    }
    process.stdout.write(
      `created bucket "${bucket.name}"\n` +
        `  substituter: ${bucket.url}\n` +
        `  public key: ${bucket.publicKey}\n\n` +
        `run \`odu cache use ${bucket.name}\` for the nix.conf lines.\n`,
    );
    return 0;
  });
}

async function listCommand(rest: string[], ports: CacheCliPorts): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: { origin: originOption, output: outputOption },
  });
  const json = values.output === "json";
  return withService(ports, values.origin, async (client) => {
    const answer = await call(client.surface.bucket.list({ rootToken: rootToken() }));
    if (!answer.ok) return reportFailure(answer, json, REFUSED);
    if (json) {
      emitJson(answer.value);
      return 0;
    }
    if (answer.value.buckets.length === 0) {
      process.stdout.write("no buckets yet — `odu cache create <bucket>`\n");
      return 0;
    }
    for (const bucket of answer.value.buckets) {
      process.stdout.write(
        `${bucket.name}${bucket.public ? "" : " (private)"}  ` +
          `${bucket.objects} paths, ${bytes(bucket.bytes)}, ` +
          `${bucket.retentionDays}d retention  ${bucket.url}\n`,
      );
    }
    return 0;
  });
}

async function useCommand(rest: string[], ports: CacheCliPorts): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { origin: originOption },
  });
  const name = positionals[0];
  if (name === undefined) {
    process.stderr.write(`odu: cache use needs a bucket name\n${CACHE_USAGE}`);
    return 1;
  }
  // A PUBLIC BUCKET'S FACTS COME OFF THE PROTOCOL, not the surface: on a
  // daemon with a door an anonymous connection is refused before a public
  // read can be answered, and "use needs no token" has to be true of a person
  // who has not signed in. The protocol's own path answers a public bucket with
  // no account — the same facts the page shows, JSON for a terminal.
  const origin = normalizeOrigin(
    values.origin ?? process.env.ODU_WEB_ORIGIN?.trim() ?? "http://127.0.0.1:18440",
  );
  const personal = process.env.ODU_TOKEN?.trim() || process.env.ODU_CACHE_TOKEN?.trim() || null;
  const publicFacts = await fetch(`${origin}${CACHE_MOUNT}/${name}/`, {
    headers: {
      accept: "application/json",
      ...(personal === null ? {} : { authorization: `Bearer ${personal}` }),
    },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (publicFacts !== null && publicFacts.ok) {
    const facts = (await publicFacts.json()) as { url?: unknown; publicKey?: unknown };
    if (typeof facts.url === "string" && typeof facts.publicKey === "string") {
      process.stdout.write(
        useBlock({
          url: facts.url,
          publicKey: facts.publicKey,
          home: process.env.HOME ?? null,
        }),
      );
      return 0;
    }
  }

  // A PRIVATE BUCKET ON A DAEMON WITH A DOOR is not readable without a
  // session, and asking the surface would be an anonymous connection refused
  // for the wrong reason. The door fact says which sentence a person needs.
  if ((await readDoor(origin)) === true) {
    process.stderr.write(
      `odu: no public bucket "${name}" on ${origin} — if it is private, sign in ` +
        `(\`odu auth login\`) or set $ODU_TOKEN to a read token\n`,
    );
    return REFUSED;
  }

  return withService(ports, values.origin, async (client) => {
    // THE FALLBACK IS A PRIVATE BUCKET ON A DAEMON WITH NO DOOR, and an unknown
    // bucket there; the surface answers both without a credential, as it always
    // did.
    const answer = await call(client.surface.bucket.describe({ bucket: name }));
    if (!answer.ok) {
      if (answer.refusal !== null) return reportFailure(answer, false, REFUSED);
      const said = String(answer.error);
      if (/no principal/i.test(said)) {
        process.stderr.write(
          `odu: "${name}" is not publicly readable — if it is private, sign in ` +
            `(\`odu auth login\`) or set $ODU_TOKEN to a read token\n`,
        );
        return REFUSED;
      }
      return reportFailure(answer, false, REFUSED);
    }
    const bucket = answer.value;
    // ONE spelling of the block, in `./surface`, because the bucket page prints
    // it too — and the two had already drifted (`~/.netrc` here, `$HOME/.netrc`
    // there, and a `flake.nix` block on only one).
    process.stdout.write(
      useBlock({
        url: bucket.url,
        publicKey: bucket.publicKey,
        home: process.env.HOME ?? null,
      }),
    );
    return 0;
  });
}

async function domainCommand(rest: string[], ports: CacheCliPorts): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { none: { type: "boolean" }, origin: originOption, output: outputOption },
  });
  const [bucket, domain] = positionals;
  if (bucket === undefined || (values.none === true) === (domain !== undefined)) {
    process.stderr.write(
      `odu: cache domain needs a bucket and a name, or --none to clear it\n${CACHE_USAGE}`,
    );
    return 1;
  }
  const json = values.output === "json";
  return withService(ports, values.origin, async (client) => {
    const answer = await call(
      client.surface.bucket.domain({
        rootToken: rootToken(),
        bucket,
        ...(values.none === true ? {} : { domain }),
      }),
    );
    if (!answer.ok) return reportFailure(answer, json, REFUSED);
    if (json) {
      emitJson(answer.value);
      return 0;
    }
    process.stdout.write(
      answer.value.domain === null
        ? `cleared the name; ${bucket} is served under /cache/${bucket}\n`
        : `named ${bucket} ${answer.value.domain}\n  substituter: ${answer.value.url}\n`,
    );
    return 0;
  });
}

async function tokenCommand(rest: string[], ports: CacheCliPorts): Promise<number> {
  const [sub, ...args] = rest;
  switch (sub) {
    case "mint": {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          read: { type: "boolean" },
          write: { type: "boolean" },
          admin: { type: "boolean" },
          "expires-days": { type: "string" },
          "no-expiry": { type: "boolean" },
          buckets: { type: "string" },
          origin: originOption,
          output: outputOption,
        },
      });
      const bucket = positionals[0];
      if (bucket === undefined) {
        process.stderr.write(`odu: cache token mint needs a bucket name\n${CACHE_USAGE}`);
        return 1;
      }
      if (values["no-expiry"] === true && values["expires-days"] !== undefined) {
        process.stderr.write(
          "odu: --no-expiry and --expires-days are opposites — a token either " +
            "expires or it does not\n",
        );
        return 1;
      }
      const json = values.output === "json";
      return withService(ports, values.origin, async (client) => {
        const answer = await call(
          client.surface.token.mint({
            rootToken: rootToken(),
            bucket,
            ...(values.buckets === undefined ? {} : { bucketGlob: values.buckets }),
            scope: scopeOf(values),
            // NINETY DAYS unless said otherwise. "Never" is a choice a person
            // types, not what happens when they forget a flag.
            ...(values["no-expiry"] === true
              ? {}
              : {
                  expiresDays:
                    values["expires-days"] === undefined
                      ? 90
                      : wholeNumber("--expires-days", values["expires-days"]),
                }),
          }),
        );
        if (!answer.ok) return reportFailure(answer, json, REFUSED);
        if (json) {
          emitJson(answer.value);
          return 0;
        }
        process.stdout.write(
          `${answer.value.token}\n` +
            `# shown once; scope ${answer.value.facts.scope}, id ${answer.value.facts.id}\n`,
        );
        return 0;
      });
    }
    case "list": {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { origin: originOption, output: outputOption },
      });
      const bucket = positionals[0];
      const json = values.output === "json";
      return withService(ports, values.origin, async (client) => {
        const answer = await call(
          client.surface.token.list({
            rootToken: rootToken(),
            ...(bucket === undefined ? {} : { bucket }),
          }),
        );
        if (!answer.ok) return reportFailure(answer, json, REFUSED);
        if (json) {
          emitJson(answer.value);
          return 0;
        }
        for (const token of answer.value.tokens) printToken(token);
        if (answer.value.tokens.length === 0) process.stdout.write("no tokens\n");
        return 0;
      });
    }
    case "revoke": {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { origin: originOption, output: outputOption },
      });
      const id = positionals[0];
      if (id === undefined) {
        process.stderr.write(`odu: cache token revoke needs a token id\n${CACHE_USAGE}`);
        return 1;
      }
      const json = values.output === "json";
      return withService(ports, values.origin, async (client) => {
        const answer = await call(
          client.surface.token.revoke({ rootToken: rootToken(), id }),
        );
        if (!answer.ok) return reportFailure(answer, json, REFUSED);
        if (json) emitJson(answer.value);
        else process.stdout.write(`revoked ${id}\n`);
        return 0;
      });
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(CACHE_USAGE);
      return sub === undefined ? 1 : 0;
    default:
      process.stderr.write(`odu: unknown cache token sub-command "${sub}"\n${CACHE_USAGE}`);
      return 1;
  }
}

async function loginCommand(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { token: { type: "string" } },
  });
  const origin = positionals[0];
  if (origin === undefined) {
    process.stderr.write(`odu: cache login needs an origin\n${CACHE_USAGE}`);
    return 1;
  }
  const token = values.token ?? (await readSecret());
  if (token === "") {
    process.stderr.write("odu: no token given\n");
    return 1;
  }
  const path = await saveCredential(process.env, origin, token);
  process.stdout.write(`saved a token for ${origin} in ${path}\n`);
  return 0;
}

/** One line from stdin. A prompt goes to STDERR, so a pipeline that feeds the
 *  token in still gets a clean stdout. */
async function readSecret(): Promise<string> {
  if (process.stdin.isTTY === true) process.stderr.write("token: ");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function pushCommand(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      "token-file": { type: "string" },
      concurrency: { type: "string" },
      "part-size": { type: "string" },
      wait: { type: "boolean" },
      origin: originOption,
      output: outputOption,
    },
  });
  const [bucket, ...paths] = positionals;
  if (bucket === undefined || paths.length === 0) {
    process.stderr.write(`odu: cache push needs a bucket and at least one path\n${CACHE_USAGE}`);
    return 1;
  }
  const json = values.output === "json";
  try {
    const summary = await pushToCache({
      bucket,
      paths,
      env: process.env,
      // An EXPLICIT origin, which beats a stored credential: a machine logged
      // in to one cache must still be able to push to a second.
      ...(values.origin === undefined ? {} : { origin: values.origin }),
      ...(values["token-file"] === undefined ? {} : { tokenFile: values["token-file"] }),
      ...(values.concurrency === undefined
        ? {}
        : { concurrency: wholeNumber("--concurrency", values.concurrency) }),
      ...(values["part-size"] === undefined
        ? {}
        : {
            partSize:
              wholeNumber("--part-size", values["part-size"]) * 1024 * 1024,
          }),
      onLine: (line) => {
        if (!json) process.stderr.write(`${line}\n`);
      },
    });
    if (json) {
      emitJson(summary);
    } else {
      process.stdout.write(
        `pushed ${summary.pushed}, skipped-upstream ${summary.skippedUpstream}, ` +
          `already-present ${summary.alreadyPresent}, ` +
          `failed ${summary.failed}\n`,
      );
      for (const failure of summary.failures) {
        process.stderr.write(`  ${failure.path}: ${failure.message}\n`);
      }
    }
    return summary.failed === 0 ? 0 : 1;
  } catch (err) {
    process.stderr.write(`odu: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function pinCommand(rest: string[], ports: CacheCliPorts): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { origin: originOption, output: outputOption },
  });
  const [bucket, name, ...paths] = positionals;
  if (bucket === undefined || name === undefined || paths.length === 0) {
    process.stderr.write(
      `odu: cache pin needs a bucket, a name and at least one path\n${CACHE_USAGE}`,
    );
    return 1;
  }
  const json = values.output === "json";
  return withService(ports, values.origin, async (client) => {
    const answer = await call(
      client.surface.pin.create({ rootToken: rootToken(), bucket, name, paths }),
    );
    if (!answer.ok) return reportFailure(answer, json, REFUSED);
    if (json) {
      emitJson(answer.value);
      return 0;
    }
    process.stdout.write(
      `pinned "${answer.value.name}" in ${answer.value.bucket}: ` +
        `${answer.value.rootPaths.length} paths\n`,
    );
    return 0;
  });
}

async function gcCommand(rest: string[], ports: CacheCliPorts): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { origin: originOption, output: outputOption },
  });
  const bucket = positionals[0];
  const json = values.output === "json";
  return withService(ports, values.origin, async (client) => {
    const answer = await call(
      client.surface.gc.run({
        rootToken: rootToken(),
        ...(bucket === undefined ? {} : { bucket }),
      }),
    );
    if (!answer.ok) return reportFailure(answer, json, REFUSED);
    if (json) {
      emitJson(answer.value);
      return 0;
    }
    for (const entry of answer.value.buckets) {
      process.stdout.write(
        `${entry.bucket}: evicted ${entry.evicted}, kept ${entry.kept} ` +
          `(still rooted elsewhere), ${bytes(entry.bytes)} reclaimed\n`,
      );
    }
    process.stdout.write(
      `total: ${answer.value.evicted} paths, ${bytes(answer.value.bytes)} reclaimed\n`,
    );
    return 0;
  });
}

async function statsCommand(rest: string[], ports: CacheCliPorts): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: { origin: originOption, output: outputOption },
  });
  const json = values.output === "json";
  return withService(ports, values.origin, async (client) => {
    const answer = await call(client.surface.stats.read({ rootToken: rootToken() }));
    if (!answer.ok) return reportFailure(answer, json, REFUSED);
    if (json) {
      emitJson(answer.value);
      return 0;
    }
    for (const bucket of answer.value.buckets) {
      process.stdout.write(
        `${bucket.name}${bucket.public ? "" : " (private)"}  ` +
          `${bucket.objects} paths, ${bytes(bucket.bytes)}, ` +
          `${bucket.retentionDays}d retention\n`,
      );
    }
    process.stdout.write(
      `total: ${answer.value.objects} paths, ${bytes(answer.value.bytes)}, ` +
        `${answer.value.hits} reads\n`,
    );
    return 0;
  });
}

function printToken(token: CacheToken): void {
  process.stdout.write(
    `${token.id}  ${token.scope.padEnd(5)}  ${token.bucketGlob}  ` +
      `${
        token.revoked
          ? "revoked"
          : token.expires === null
            ? "no expiry"
            : `expires ${new Date(token.expires).toISOString().slice(0, 10)}`
      }  ${token.lastUsed === null ? "never used" : `last used ${new Date(token.lastUsed).toISOString().slice(0, 16)}`}\n`,
  );
}

/** Bytes as a person reads them. Binary units, because a store is. */
