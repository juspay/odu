/**
 * `odu cache` — the cache's SHELL-NATIVE verbs, in the package that owns the
 * buckets.
 *
 * Three commands are left, and what they have in common is a machine:
 *
 *   - **`push`** is a client of the cache's HTTP API, run from the machine
 *     that holds the store paths. It imports `./push` and nothing else — no
 *     service, no catalog, no engine — which is the argument `@odu/cli`'s
 *     `authority.test.ts` makes for why it is admissible under a wall that
 *     forbids every public client the engine.
 *   - **`login`** writes this machine's token for an origin, which is the
 *     credential `push` then reads. A credential store is a file on a disk,
 *     so there is nothing for a browser or an API verb to do here.
 *   - **`use`** prints the nix.conf, flake `nixConfig` and netrc lines for a
 *     bucket, for pasting into this machine's configuration. It needs no
 *     token: a bucket's URL and public key are what it publishes.
 *
 * ADMINISTRATION IS NOT HERE ANY MORE. Creating a bucket, minting and revoking
 * tokens, naming a domain, pinning a closure, collecting garbage and reading
 * the stats are controls on the bucket page, and verbs on the API — `odu
 * surface cache bucket_create`, `cache token_mint`, `cache gc_run` … — which
 * is the same vocabulary `odu mcp` serves an agent. A second argv spelling of
 * a verb the board already owns was a face that had to be kept in step with
 * the row for no capability in return.
 *
 * ## The dial is a PORT, bound by the root
 *
 * This module is a FACE, and `use` dials the daemon when a bucket is not
 * publicly readable. The bootstrap — "start one if nothing is serving" —
 * belongs to `@odu/host`, and a ROW never names the host: that is the arrow
 * backwards. So the root binds a `connect` here (`src/main.ts`), and this
 * face stays a client that names no host.
 */

import { parseArgs } from "node:util";
import type { SurfaceClientOf } from "@kolu/surface/project";
import { composedClients } from "@odu/cordis/compose";
import { readDoor } from "@odu/cordis/services";
import type { SurfaceDispatch } from "@kolu/surface/link";
import { Effect } from "effect";
import { CACHE_MOUNT } from "./paths";
import { normalizeOrigin, pushToCache, saveCredential } from "./push";
import {
  CACHE_KEY,
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

export const CACHE_USAGE = `usage: odu cache <use|login|push> [args]

use <bucket>                  the nix.conf settings, the nixConfig block and the
                              netrc lines for a bucket. Needs NO token: a
                              bucket's URL and public key are public
login <origin> [--token T]    save a token for an origin in
                              ~/.config/odu/cache/credentials (0600)
push <bucket> <path>… [--token-file F] [--concurrency N] [--part-size MiB] [--pin NAME] [-o json]
                              upload only the paths the bucket is missing.
                              Talks to the cache directly, from HERE. A NAR
                              larger than --part-size (64 MiB) is sent in parts,
                              each retried on its own.
                              --pin re-points that named pin at the closure
                              this push landed, so garbage collection keeps it.
                              The write token is the authority; nothing is
                              pinned if any path was refused

Buckets, tokens, domains, pins, GC and stats are the bucket page on the board,
or the API: \`odu surface cache bucket_create --input '{…}' --json\`,
\`cache token_mint\`, \`cache bucket_domain\`, \`cache pin_create\`, \`cache gc_run\`,
\`cache stats_read\` — the same verbs \`odu mcp\` serves an agent, each taking the
server's root token as a field of its input.

--origin URL is accepted by \`use\` and by \`push\`, where it BEATS a stored
credential - a machine logged in to one cache can still push to a second
(default $ODU_WEB_ORIGIN or http://127.0.0.1:18440).

Token resolution for \`push\`: --token-file, then $ODU_CACHE_TOKEN, then the
credentials entry for the bucket's origin.
`;

/** What `use` exits with when the service refuses it: 1. The run-shaped table
 *  in `serviceFace` numbers the states of a RUN, and a bucket is not one. */
const REFUSED = 1;


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
 *  `--part-size=` as "no bytes at all" — which is a destructive reading of a
 *  typo. */
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
    case "use":
      return useCommand(rest, ports);
    case "login":
      return loginCommand(rest);
    case "push":
      return pushCommand(rest);
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
      pin: { type: "string" },
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
      // THE PIN THE PUSH RE-POINTS, when the caller asked for one. A flag on
      // the push rather than a verb of its own: the pin names what THIS push
      // put there, and the write token is already in hand.
      ...(values.pin === undefined ? {} : { pin: values.pin }),
      onLine: (line) => {
        if (!json) process.stderr.write(`${line}\n`);
      },
    });
    if (json) {
      emitJson(summary);
    } else {
      process.stdout.write(
        `pushed ${summary.pushed}, skipped-upstream ${summary.skippedUpstream}, ` +
          `already-present ${summary.alreadyPresent}, failed ${summary.failed}\n`,
      );
      for (const failure of summary.failures) {
        process.stderr.write(`  ${failure.path}: ${failure.message}\n`);
      }
      if (summary.pinned !== null) {
        process.stdout.write(
          `pinned "${summary.pinned.name}": ${summary.pinned.rootPaths} paths kept from GC\n`,
        );
      }
    }
    return summary.failed === 0 ? 0 : 1;
  } catch (err) {
    process.stderr.write(`odu: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

