/**
 * `odu cache` — the bucket commands.
 *
 * Two kinds of client in one command, and the split is the interesting part:
 *
 *   - **administration** (`create`, `list`, `use`, `token`, `pin`, `gc`,
 *     `stats`) is a thin client of the shared service, like every other public
 *     verb. The buckets, their keys and their tokens live in the service's
 *     database, and a second reader would be a second answer.
 *   - **`push` and `login`** are clients of the cache's HTTP API, from the
 *     machine that holds the paths. They import `@odu/cache/push` and nothing
 *     else of odu — no service, no catalog, no engine — which is exactly the
 *     argument `authority.test.ts`'s header makes for why they are admissible
 *     under a wall that forbids every public client the engine.
 *
 * The root token comes from `$ODU_ROOT_TOKEN` and is passed straight through:
 * the CLI does not decide who may administer a bucket, and neither does the
 * service — the cache does, because it is the one that holds the secret.
 */

import { parseArgs } from "node:util";
import { pushToCache, saveCredential } from "@odu/cache/push";
import type { CacheScope, CacheToken } from "@odu/service-client/surface";
import { call, emitJson, reportFailure, withService } from "./serviceFace";

export const CACHE_USAGE = `usage: odu cache <create|list|use|token|login|push|pin|gc|stats> [args]

create <bucket> [--private] [--retention-days N] [--upstream-key K]… | --no-upstream
                              create a bucket; print its substituter URL and
                              public key. Needs $ODU_ROOT_TOKEN.
                              --no-upstream takes everything: for a server whose
                              store is not the machine that built the paths
list [-o json]                buckets, with sizes. Needs $ODU_ROOT_TOKEN
use <bucket>                  the nix.conf settings, the nixConfig block and the
                              netrc lines for a bucket. Needs NO token: a
                              bucket's URL and public key are public
token mint <bucket> [--read|--write|--admin] [--expires-days N] [--buckets GLOB]
                              mint a token. It is printed ONCE; only its hash
                              is kept
token list [bucket] [-o json] tokens with scope, expiry and last use
token revoke <id>             revoke one token, without touching the rest
login <origin> [--token T]    save a token for an origin in
                              ~/.config/odu/cache/credentials (0600)
push <bucket> <path>… [--token-file F] [--concurrency N] [-o json]
                              upload only the paths the bucket is missing.
                              Talks to the cache directly, from HERE
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
): Promise<number> {
  switch (sub) {
    case "create":
      return createCommand(rest);
    case "list":
      return listCommand(rest);
    case "use":
      return useCommand(rest);
    case "token":
      return tokenCommand(rest);
    case "login":
      return loginCommand(rest);
    case "push":
      return pushCommand(rest);
    case "pin":
      return pinCommand(rest);
    case "gc":
      return gcCommand(rest);
    case "stats":
      return statsCommand(rest);
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

async function createCommand(rest: string[]): Promise<number> {
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
  return withService(values.origin, async (client) => {
    const answer = await call(
      client.surface.cache.create({
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

async function listCommand(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: { origin: originOption, output: outputOption },
  });
  const json = values.output === "json";
  return withService(values.origin, async (client) => {
    const answer = await call(client.surface.cache.list({ rootToken: rootToken() }));
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

async function useCommand(rest: string[]): Promise<number> {
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
  return withService(values.origin, async (client) => {
    // NO ROOT TOKEN: a bucket's substituter URL and public key are what it
    // publishes to every client that talks to it, so asking the operator's
    // credential for them would turn a read-only question into an
    // administrative act.
    const answer = await call(client.surface.cache.describe({ bucket: name }));
    if (!answer.ok) return reportFailure(answer, false, REFUSED);
    const bucket = answer.value;
    const url = new URL(bucket.url);
    // A PLACEHOLDER, never a live token: this output is pasted into a
    // `flake.nix` and a `nix.conf`, which are read by people and committed.
    process.stdout.write(
      `# nix.conf\n` +
        `extra-substituters = ${bucket.url}\n` +
        `extra-trusted-public-keys = ${bucket.publicKey}\n\n` +
        `# flake.nix\n` +
        `{\n  nixConfig = {\n` +
        `    extra-substituters = [ "${bucket.url}" ];\n` +
        `    extra-trusted-public-keys = [ "${bucket.publicKey}" ];\n` +
        `  };\n}\n\n` +
        `# netrc — Nix reads only the file named by netrc-file, never ~/.netrc\n` +
        `netrc-file = ${process.env.HOME ?? "~"}/.netrc\n` +
        `machine ${url.hostname} password <your-write-token>\n`,
    );
    return 0;
  });
}

async function tokenCommand(rest: string[]): Promise<number> {
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
      const json = values.output === "json";
      return withService(values.origin, async (client) => {
        const answer = await call(
          client.surface.cache.tokenMint({
            rootToken: rootToken(),
            bucket,
            ...(values.buckets === undefined ? {} : { bucketGlob: values.buckets }),
            scope: scopeOf(values),
            ...(values["expires-days"] === undefined
              ? {}
              : { expiresDays: wholeNumber("--expires-days", values["expires-days"]) }),
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
      return withService(values.origin, async (client) => {
        const answer = await call(
          client.surface.cache.tokenList({
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
      return withService(values.origin, async (client) => {
        const answer = await call(
          client.surface.cache.tokenRevoke({ rootToken: rootToken(), id }),
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
    }
    return summary.failed === 0 ? 0 : 1;
  } catch (err) {
    process.stderr.write(`odu: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

async function pinCommand(rest: string[]): Promise<number> {
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
  return withService(values.origin, async (client) => {
    const answer = await call(
      client.surface.cache.pin({ rootToken: rootToken(), bucket, name, paths }),
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

async function gcCommand(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { origin: originOption, output: outputOption },
  });
  const bucket = positionals[0];
  const json = values.output === "json";
  return withService(values.origin, async (client) => {
    const answer = await call(
      client.surface.cache.gc({
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

async function statsCommand(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    options: { origin: originOption, output: outputOption },
  });
  const json = values.output === "json";
  return withService(values.origin, async (client) => {
    const answer = await call(client.surface.cache.stats({ rootToken: rootToken() }));
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
function bytes(count: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = count;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit] as string}`;
}
