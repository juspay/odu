/**
 * `odu cloudflare setup|status|destroy` — the one-time act that makes a
 * `cloudflare[:<instance>]` lane host dialable.
 *
 * `setup` deploys the `odu-lane` Worker that ships inside odu
 * (`packages/cloudflare-lane`) to the operator's OWN Cloudflare account, with
 * the wrangler odu pins, and writes what the coordinator needs to dial it into
 * `~/.config/odu/cloudflare.json`. There is no per-project file: a repo opts in
 * by naming `cloudflare` in hosts.json like any other host.
 *
 * Idempotent: re-running it redeploys the Worker and keeps the secret and the
 * signing key, so a container that is already warm keeps trusting the cache.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type CloudflareConfig,
  cloudflareConfigPath,
  type LaneCacheConfig,
  oduConfigDir,
  readCloudflareConfig,
} from "@odu/execution/common/cloudflareConfig";

const WORKER_NAME = "odu-lane";
const BUCKET = "odu-lane-cache";
/** Pulled by Cloudflare straight from Docker Hub — no Dockerfile, no registry
 *  push. Its bash path is pinned in worker.ts, so the two move together. */
const IMAGE = "docker.io/nixos/nix:2.35.2-amd64";
const INSTANCE_TYPE = "standard-4";

const USAGE = `usage: odu cloudflare <setup|status|destroy> [args]

setup [--max-instances N] [--s3-cache URL] [--no-cache]
      deploy the odu-lane Worker + R2 cache to your Cloudflare account (wrangler
      must be logged in, or CLOUDFLARE_API_TOKEN set) and write
      ~/.config/odu/cloudflare.json. Then name "cloudflare" (or
      "cloudflare:<instance>") as a host in hosts.json or --host.
      --s3-cache s3://odu-lane-cache?endpoint=<acct>.r2.cloudflarestorage.com&region=auto
      uses R2's S3 API instead of the Worker-proxied cache; needs
      R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY in the environment.
      --no-cache (or R2 not enabled on the account): no lane cache; a cold
      container gets the runner closure shipped through the Worker instead.
status                     the config and whether the Worker answers
destroy [INSTANCE]         kill a container (default: "default")
`;

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** The pinned wrangler: baked onto the odu wrapper as a store path that is
 *  realised on first use (it is not in odu's closure — most users never run
 *  setup), else whatever `wrangler` is on PATH in a dev shell. */
function wranglerBin(): string {
  const pinned = process.env.ODU_WRANGLER;
  if (pinned !== undefined && pinned !== "") {
    if (!existsSync(pinned)) {
      log(`odu: realising wrangler ${pinned}`);
      execFileSync("nix-store", ["--realise", pinned], { stdio: ["ignore", "ignore", "inherit"] });
    }
    return join(pinned, "bin", "wrangler");
  }
  return "wrangler";
}

function wrangler(args: string[], opts: { cwd?: string; input?: string } = {}): string {
  const result = spawnSync(wranglerBin(), args, {
    cwd: opts.cwd,
    input: opts.input,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    throw Object.assign(new Error(`wrangler ${args.join(" ")} failed:\n${out}`), { output: out });
  }
  return out;
}

/** odu's own bun, by store path: the container realises exactly this one to
 *  run its bridge, and it is the bun the runner closure already carries. */
function bunStorePath(): string {
  const path = resolve(dirname(process.execPath), "..");
  if (!/^\/nix\/store\/[0-9a-z]{32}-bun-/.test(path)) {
    throw new Error(`odu: cannot find odu's bun store path (process.execPath is ${process.execPath}) — run odu from its Nix package`);
  }
  return path;
}

function workerSourceDir(): string {
  return resolve(import.meta.dirname, "..", "..", "cloudflare-lane");
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? "").split(/\s+/).filter((s) => s !== "");
}

function ensureSigningKey(dir: string): { secretKeyFile: string; publicKey: string } {
  const secretKeyFile = join(dir, "cloudflare-lane-cache.sec");
  if (!existsSync(secretKeyFile)) {
    const name = `odu-lane-${hostname().split(".")[0]}-1`;
    const secret = execFileSync("nix", ["--extra-experimental-features", "nix-command", "key", "generate-secret", "--key-name", name], { encoding: "utf-8" });
    writeFileSync(secretKeyFile, secret, { mode: 0o600 });
    log(`odu: generated lane-cache signing key ${name}`);
  }
  const publicKey = execFileSync("nix", ["--extra-experimental-features", "nix-command", "key", "convert-secret-to-public"], {
    input: readFileSync(secretKeyFile),
    encoding: "utf-8",
  }).trim();
  return { secretKeyFile, publicKey };
}

interface SetupOptions {
  maxInstances: number;
  s3Cache: string | null;
  noCache: boolean;
}

function writeWranglerConfig(dir: string, opts: SetupOptions & { bun: string; publicKey: string; r2: boolean }): void {
  const src = join(workerSourceDir(), "src");
  const config = {
    name: WORKER_NAME,
    main: join(src, "worker.ts"),
    compatibility_date: "2026-09-01",
    // bridge.ts and entrypoint.sh travel as TEXT inside the Worker and are
    // handed to the container as env, so the image stays stock nixos/nix.
    rules: [{ type: "Text", globs: ["**/bridge.ts", "**/entrypoint.sh"], fallthrough: false }],
    observability: { enabled: true },
    containers: [
      { class_name: "OduLane", image: IMAGE, instance_type: INSTANCE_TYPE, max_instances: opts.maxInstances },
    ],
    durable_objects: { bindings: [{ name: "LANE", class_name: "OduLane" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["OduLane"] }],
    ...(opts.r2 ? { r2_buckets: [{ binding: "CACHE", bucket_name: BUCKET }] } : {}),
    vars: {
      ODU_LANE_BUN: opts.bun,
      ODU_LANE_CACHE_PUBLIC_KEY: opts.publicKey,
      ODU_LANE_CACHE_URL: opts.s3Cache ?? "",
      ODU_LANE_EXTRA_SUBSTITUTERS: splitList(process.env.ODU_AGENT_SUBSTITUTERS).join(" "),
      ODU_LANE_EXTRA_TRUSTED_KEYS: splitList(process.env.ODU_AGENT_TRUSTED_PUBLIC_KEYS).join(" "),
    },
  };
  writeFileSync(join(dir, "wrangler.json"), `${JSON.stringify(config, null, 2)}\n`);
}

async function setup(opts: SetupOptions): Promise<number> {
  const configDir = oduConfigDir();
  mkdirSync(configDir, { recursive: true });
  const deployDir = join(homedir(), ".cache", "odu", "cloudflare-lane");
  mkdirSync(deployDir, { recursive: true });

  log("odu: checking wrangler login");
  const who = wrangler(["whoami"]);
  if (/not authenticated/i.test(who)) {
    log("odu: wrangler is not logged in — run `wrangler login` (or set CLOUDFLARE_API_TOKEN) and retry");
    return 1;
  }

  const previous = readCloudflareConfig();
  const secret = previous?.secret ?? randomBytes(32).toString("base64url");
  const { secretKeyFile, publicKey } = ensureSigningKey(configDir);
  const bun = bunStorePath();

  // The lane cache is an R2 bucket. R2 is opt-in per account (a dashboard
  // click wrangler cannot make), so its absence degrades to shipping the
  // closure over the Worker (shipClosure.ts) rather than refusing setup.
  let r2 = !opts.noCache;
  if (r2) {
    log(`odu: ensuring R2 bucket ${BUCKET}`);
    try {
      wrangler(["r2", "bucket", "create", BUCKET]);
    } catch (error) {
      const output = (error as { output?: string }).output ?? "";
      if (/already exists|already own/i.test(output)) {
        // fine
      } else if (/enable R2|10042/i.test(output)) {
        r2 = false;
        log(
          "odu: R2 is not enabled on this Cloudflare account (dashboard → R2 → enable/purchase).\n" +
            "     Continuing WITHOUT a lane cache: each cold container is provisioned by shipping\n" +
            "     the runner closure through the Worker. Re-run setup after enabling R2.",
        );
      } else {
        throw error;
      }
    }
  }
  if (!r2 && opts.s3Cache !== null) {
    log("odu: --s3-cache needs R2 enabled on the account");
    return 1;
  }

  writeWranglerConfig(deployDir, { ...opts, bun, publicKey, r2 });
  log(`odu: deploying ${WORKER_NAME} (image ${IMAGE}, ${INSTANCE_TYPE}, max ${opts.maxInstances} containers)`);
  const deployed = wrangler(["deploy"], { cwd: deployDir });
  const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(deployed)?.[0] ?? previous?.workerUrl;
  if (url === undefined) {
    log(deployed);
    log("odu: could not find the Worker URL in wrangler's output");
    return 1;
  }
  wrangler(["secret", "put", "ODU_LANE_SECRET"], { cwd: deployDir, input: secret });

  let cache: LaneCacheConfig | null;
  if (!r2) {
    cache = null;
  } else if (opts.s3Cache !== null) {
    const id = process.env.R2_ACCESS_KEY_ID;
    const key = process.env.R2_SECRET_ACCESS_KEY;
    if (id === undefined || key === undefined) {
      log("odu: --s3-cache needs R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (an R2 API token with Object Read & Write on the bucket)");
      return 1;
    }
    const awsCredentialsFile = join(configDir, "cloudflare-r2.credentials");
    writeFileSync(awsCredentialsFile, `[default]\naws_access_key_id = ${id}\naws_secret_access_key = ${key}\n`, { mode: 0o600 });
    wrangler(["secret", "put", "AWS_ACCESS_KEY_ID"], { cwd: deployDir, input: id });
    wrangler(["secret", "put", "AWS_SECRET_ACCESS_KEY"], { cwd: deployDir, input: key });
    cache = { url: opts.s3Cache, secretKeyFile, publicKey, netrcFile: null, awsCredentialsFile };
  } else {
    const netrcFile = join(configDir, "cloudflare-lane.netrc");
    writeFileSync(netrcFile, `machine ${new URL(url).hostname} login odu password ${secret}\n`, { mode: 0o600 });
    cache = { url: `${url}/nix-cache`, secretKeyFile, publicKey, netrcFile, awsCredentialsFile: null };
  }

  const config: CloudflareConfig = { workerUrl: url, secret, cache };
  writeFileSync(cloudflareConfigPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(cloudflareConfigPath(), 0o600);
  log(`odu: wrote ${cloudflareConfigPath()}`);
  log(`odu: ${WORKER_NAME} is at ${url}`);
  log('odu: use it with --host x86_64-linux=cloudflare, or {"x86_64-linux": "cloudflare"} in hosts.json');
  return 0;
}

async function status(): Promise<number> {
  const config = readCloudflareConfig();
  if (config === null) {
    log(`odu: no ${cloudflareConfigPath()} — run \`odu cloudflare setup\``);
    return 1;
  }
  const health = await fetch(`${config.workerUrl}/healthz`).then((r) => r.status, () => 0);
  process.stdout.write(
    `${JSON.stringify({ workerUrl: config.workerUrl, cache: config.cache?.url ?? null, healthz: health }, null, 2)}\n`,
  );
  return health === 200 ? 0 : 1;
}

async function destroy(instance: string): Promise<number> {
  const config = readCloudflareConfig();
  if (config === null) {
    log(`odu: no ${cloudflareConfigPath()} — run \`odu cloudflare setup\``);
    return 1;
  }
  const response = await fetch(`${config.workerUrl}/lane/${instance}/destroy`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.secret}` },
  });
  log(`odu: ${instance}: ${response.status} ${(await response.text()).trim()}`);
  return response.ok ? 0 : 1;
}

export async function cloudflareCommand(args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "setup": {
      const { values } = parseArgs({
        args: rest,
        options: {
          "max-instances": { type: "string" },
          "s3-cache": { type: "string" },
          "no-cache": { type: "boolean" },
        },
      });
      const maxInstances = Number(values["max-instances"] ?? "8");
      if (!Number.isInteger(maxInstances) || maxInstances < 1) {
        log("odu: --max-instances needs a positive integer");
        return 2;
      }
      return setup({ maxInstances, s3Cache: values["s3-cache"] ?? null, noCache: values["no-cache"] ?? false });
    }
    case "status":
      return status();
    case "destroy":
      return destroy(rest[0] ?? "default");
    default:
      process.stderr.write(USAGE);
      return sub === undefined || sub === "help" || sub === "--help" ? 0 : 2;
  }
}
