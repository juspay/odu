import { parseArgs } from "node:util";
import type { SurfaceClientOf } from "@kolu/surface/project";
import { composedClients } from "@odu/cordis/compose";
import { readDoor } from "@odu/cordis/services";
import type { SurfaceDispatch } from "@kolu/surface/link";
import { Effect } from "effect";
import { existsSync } from "node:fs";
import { CACHE_MOUNT } from "./paths";
import {
  describeCache,
  discoveryToken,
  savedCredentialFor,
  trimTrailingSlashes,
  oduCachesOf,
  pushToCache,
  nixEvalFlakeConfig,
  readFlakeNixConfig,
  saveCredential,
} from "./push";
import {
  CACHE_KEY,
  CacheRefused,
  oduCacheSurface,
  useBlock,
} from "./surface";

export type CacheClient = SurfaceClientOf<(typeof oduCacheSurface)["spec"]>;

function composedCacheSibling(dispatch: SurfaceDispatch): CacheClient {
  return composedClients(
    { [CACHE_KEY]: oduCacheSurface },
    dispatch,
  ).cache as unknown as CacheClient;
}

export interface CacheCliPorts {
  /** Reach the daemon — starting it when nothing is serving and the origin is
   *  this install's own. */
  connect(origin: string | undefined): Promise<{
    dispatch: SurfaceDispatch;
    dispose: () => Promise<void>;
  }>;
}

export const CACHE_USAGE = `usage: odu cache <use|login|push|target> [args]

use <bucket>                  the nix.conf settings and the nixConfig block for
                              a bucket, and the netrc lines for a private one.
                              Needs NO token for a public bucket: a bucket's URL
                              and public key are public
login <origin> [--token T]    save a token for an origin in
                              ~/.config/odu/cache/credentials (0600)
push <bucket> <path>… [--token-file F] [--concurrency N] [--part-size MiB] [--pin NAME] [--run ID] [--commit SHA] [--whole] [-o json]
push --cache <substituter> <path>…
push <path>…                  with neither, the substituter is read from
                              ./flake.nix's nixConfig — the one declaration a
                              repository that READS from an odu cache already
                              has. Two odu caches named there is a refusal,
                              because a repository builds for one
                              upload only the paths the bucket is missing.
                              Talks to the cache directly, from HERE. Where a
                              NAR's bytes go is the BUCKET's answer: on an S3
                              store they go straight to the store through
                              presigned URLs odu mints, and odu reads the
                              object back to verify it; on disk they come
                              through the daemon. --part-size is a ceiling
                              there (64 MiB, under a proxy's body cap) and a
                              FLOOR on an S3 store, where a part is at least
                              5 MiB whatever is asked for. Each part is
                              retried on its own.
                              --cache takes the SUBSTITUTER URL a nix.conf
                              already has: the cache names its own push origin
                              and bucket in nix-cache-info, so a workflow keeps
                              one fact instead of three. Exclusive with
                              <bucket> --origin, and unnecessary when
                              ./flake.nix names exactly one odu cache
                              --pin re-points that named pin at the closure
                              this push landed, so garbage collection keeps it.
                              The write token is the authority; nothing is
                              pinned if any path was refused
                              --run and --commit state WHAT BUILT the paths:
                              the bucket keeps both on every row this push
                              stores and shows them on its page, so a path
                              nobody recognises can be traced to the run and
                              the commit that made it. Two opaque strings —
                              the cache never learns what a run is. A push
                              that states neither leaves whatever a run
                              already stated about these paths alone
                              --whole stores the closure's upstream-signed
                              paths too, for a closure that is fetched from
                              this bucket alone (\`nix copy --from\` reads one
                              cache). Without it they are skipped as upstream.
                              If the service is too old to store the whole
                              closure, the push stops before sending anything
                              and says so
target [-o json]              print the one odu substituter ./flake.nix's
                              nixConfig names — the same reading \`push\` makes
                              with no --cache, said out loud instead of acted
                              on. The URL on stdout; -o json gives
                              {cache, origin, bucket}. A caller that names it
                              back (\`push --cache <that>\`) is naming the
                              target itself, so its own token goes with it

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

const REFUSED = 1;

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
    return await use(composedCacheSibling(connection.dispatch));
  } finally {
    await connection.dispose();
  }
}

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

/** `Number("")` is 0 and `Number(" 5 ")` is 5, so a bare `Number` would read a
 *  truncated `--part-size=` as "no bytes at all". */
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
    case "target":
      return targetCommand(rest);
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
  const origin = trimTrailingSlashes(
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
    const facts = (await publicFacts.json()) as {
      url?: unknown;
      publicKey?: unknown;
      public?: unknown;
    };
    if (typeof facts.url === "string" && typeof facts.publicKey === "string") {
      process.stdout.write(
        useBlock({
          url: facts.url,
          publicKey: facts.publicKey,
          public: facts.public === true,
          home: process.env.HOME ?? null,
        }),
      );
      return 0;
    }
  }

  if ((await readDoor(origin)) === true) {
    process.stderr.write(
      `odu: no public bucket "${name}" on ${origin} — if it is private, sign in ` +
        `(\`odu auth login\`) or set $ODU_TOKEN to a read token\n`,
    );
    return REFUSED;
  }

  return withService(ports, values.origin, async (client) => {
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
    process.stdout.write(
      useBlock({
        url: bucket.url,
        publicKey: bucket.publicKey,
        public: bucket.public,
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
      run: { type: "string" },
      commit: { type: "string" },
      cache: { type: "string" },
      whole: { type: "boolean" },
      origin: originOption,
      output: outputOption,
    },
  });
  const json = values.output === "json";
  const asked = values.cache;
  let bucket: string;
  let origin = values.origin;
  let addressFromRepository = false;
  let paths: string[];
  if (asked !== undefined) {
    if (values.origin !== undefined) {
      process.stderr.write(
        "odu: --cache and --origin name the same thing twice — --cache reads the " +
          "push origin from the cache itself\n",
      );
      return 1;
    }
    if (positionals.length === 0) {
      process.stderr.write(`odu: cache push --cache needs at least one path\n${CACHE_USAGE}`);
      return 1;
    }
    const named = positionals.filter(
      (item) => !(item.startsWith("/") || item.includes("#") || existsSync(item)),
    );
    if (named.length > 0) {
      process.stderr.write(
        `odu: --cache names the bucket, so "${named[0] as string}" is not a path it can ` +
          `push — with --cache every positional is a store path, a result link or a ` +
          `flake installable. Drop it, or use \`odu cache push ${named[0] as string} ` +
          `--origin <url>\`\n`,
      );
      return 1;
    }
    try {
      const token = await discoveryToken(process.env, asked, values["token-file"]);
      const facts = await describeCache(asked, fetch, token);
      bucket = facts.bucket;
      origin = facts.origin;
      if (!json) {
        process.stderr.write(`${asked} is bucket "${facts.bucket}" on ${facts.origin}\n`);
      }
    } catch (err) {
      process.stderr.write(`odu: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    paths = positionals;
  } else {
    const [named, ...rest] = positionals;
    const looksLikeBucket =
      named !== undefined &&
      !(named.startsWith("/") || named.includes("#") || existsSync(named));
    if (looksLikeBucket) {
      if (rest.length === 0) {
        process.stderr.write(
          `odu: cache push needs a bucket and at least one path\n${CACHE_USAGE}`,
        );
        return 1;
      }
      bucket = named;
      paths = rest;
    } else {
      if (positionals.length === 0) {
        process.stderr.write(`odu: cache push needs at least one path\n${CACHE_USAGE}`);
        return 1;
      }
      if (values.origin !== undefined) {
        process.stderr.write(
          "odu: --origin needs a bucket to go with it — `odu cache push <bucket> " +
            "--origin <url>`. With neither, the substituter is read from " +
            "./flake.nix and names its own origin.\n",
        );
        return 1;
      }
      const inferred = await inferredCache();
      if ("error" in inferred) {
        process.stderr.write(`odu: ${inferred.error}\n`);
        return 1;
      }
      if (!json) {
        process.stderr.write(
          `./flake.nix reads from ${inferred.substituter}, which is bucket ` +
            `"${inferred.bucket}" on ${inferred.origin}\n`,
        );
      }
      bucket = inferred.bucket;
      origin = inferred.origin;
      addressFromRepository = true;
      paths = positionals;
    }
  }
  const credential = addressFromRepository
    ? await savedCredentialFor(process.env, origin ?? "")
    : undefined;
  try {
    const summary = await pushToCache({
      bucket,
      paths,
      env: process.env,
      ...(origin === undefined ? {} : { origin }),
      ...(credential === undefined ? {} : { credential }),
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
      ...(values.pin === undefined ? {} : { pin: values.pin }),
      ...(values.run === undefined ? {} : { run: values.run }),
      ...(values.commit === undefined ? {} : { commit: values.commit }),
      whole: values.whole === true,
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
    const said = err instanceof Error ? err.message : String(err);
    const hint =
      credential === null
        ? ` — the substituter came from ./flake.nix and nothing is saved for ` +
          `${origin ?? "it"}, so this push was anonymous. Run \`odu cache ` +
          `login ${origin ?? "<url>"}\`, or name the cache yourself with ` +
          "`odu cache push <bucket> --origin <url>`"
        : "";
    process.stderr.write(`odu: ${said}${hint}\n`);
    return 1;
  }
}

async function targetCommand(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { output: outputOption },
  });
  if (positionals.length > 0) {
    process.stderr.write(
      `odu: cache target takes no arguments — it reads ./flake.nix\n${CACHE_USAGE}`,
    );
    return 1;
  }
  const json = values.output === "json";
  const inferred = await inferredCache();
  if ("error" in inferred) {
    process.stderr.write(`odu: ${inferred.error}\n`);
    return 1;
  }
  const { substituter: cache, origin, bucket } = inferred;
  if (json) {
    emitJson({ cache, origin, bucket });
  } else {
    process.stdout.write(`${cache}\n`);
  }
  return 0;
}

async function inferredCache(): Promise<
  { substituter: string; bucket: string; origin: string } | { error: string }
> {
  const config = await readFlakeNixConfig(
    process.cwd(),
    nixEvalFlakeConfig(process.env),
  );
  if (!config.ok) {
    return {
      error:
        `${config.reason} — name the cache with \`--cache <substituter>\`, or the ` +
        "bucket with `<bucket> --origin <url>`",
    };
  }
  const found = await oduCachesOf(config.config.substituters);
  const one = found[0];
  if (one === undefined) {
    return {
      error:
        "no substituter in ./flake.nix nixConfig answered as an odu cache — a " +
        "PRIVATE bucket answers its nix-cache-info to nobody, so name it with " +
        "`--cache <substituter>`",
    };
  }
  if (found.length > 1) {
    return {
      error:
        `./flake.nix nixConfig names ${found.length} odu caches ` +
        `(${found.map((cache) => cache.substituter).join(", ")}) — a repository pushes ` +
        "to one, so name it with `--cache <substituter>`",
    };
  }
  return { substituter: one.substituter, bucket: one.bucket, origin: one.origin };
}

