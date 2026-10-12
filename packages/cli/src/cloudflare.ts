/**
 * `odu cloudflare setup|status|destroy|teardown` — the one-time act that makes
 * a `cloudflare[:<instance>]` lane host dialable, and the way back out.
 *
 * `setup` deploys the two Workers that ship inside odu
 * (`packages/cloudflare-lane`: the `odu-lane` control plane and the
 * `odu-lane-dp` data plane) to the operator's OWN Cloudflare account, with the
 * wrangler odu pins, and writes what the coordinator needs to dial them into
 * `cloudflare.json` in odu's config directory. There is no per-project file: a
 * repo opts in by naming `cloudflare` in hosts.json like any other host.
 *
 * Idempotent: re-running it redeploys only a plane whose fingerprint changed,
 * and keeps the secret and the signing key, so a container that is already
 * warm keeps trusting the cache.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type CloudflareConfig,
  cloudflareConfigPath,
  cloudflareInstance,
  declaredCloudflareHosts,
  type LaneCacheConfig,
  laneAuthHeaders,
  laneEndpoint,
  oduConfigDir,
  parseWorkerUrl,
  readCloudflareConfig,
} from "@odu/execution/common/cloudflareConfig";

const WORKER_NAME = "odu-lane";
const BUCKET = "odu-lane-cache";
/** Pulled by Cloudflare straight from Docker Hub — no Dockerfile, no registry
 *  push. Its bash path is pinned in worker.ts, so the two move together. */
const IMAGE = "docker.io/nixos/nix:2.35.2-amd64";
const INSTANCE_TYPE = "standard-4";

const USAGE = `usage: odu cloudflare <setup|status|destroy|teardown> [args]

setup [--max-instances N] [--github-token | --no-github-token]
      [--s3-cache URL] [--no-cache] [--force]
      deploy odu's two lane Workers (odu-lane: routes, cache, secrets;
      odu-lane-dp: the containers) and the R2 lane cache to YOUR Cloudflare
      account (Workers Paid; \`wrangler login\` first, or CLOUDFLARE_API_TOKEN)
      and write cloudflare.json in $ODU_CONFIG_DIR (default ~/.config/odu).
      Only what changed is redeployed. Re-run it after changing hosts.json:
      max_instances is sized from the cloudflare hosts declared there (x2,
      at least 8). Without R2 enabled, lanes still work: a cold container
      gets the runner shipped through the Worker instead of from a cache.
      --github-token  give containers your GitHub token (GH_TOKEN, else
                      \`gh auth token\`) for private origins and api.github.com.
      --s3-cache s3://odu-lane-cache?endpoint=<account>.r2.cloudflarestorage.com&region=auto
                      use R2's S3 API instead of the Worker-proxied cache; needs
                      R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY in the environment.
      --no-cache      no lane cache: a cold container gets the runner closure
                      shipped through the Worker instead.
      --force         redeploy even while a declared cloudflare host is running
                      (its attached lanes drop ~5 min later; odu re-runs them).
status                which configured cloudflare hosts are running now, and
                      what that costs per hour
destroy [INSTANCE]    stop one container now (default: "default")
teardown [--yes]      delete both Workers, their containers, the R2 bucket and
                      the local credentials
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
    // Unconditional: a no-op when it is already valid, and no check-then-act.
    execFileSync("nix-store", ["--realise", pinned], { stdio: ["ignore", "ignore", "pipe"] });
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

/** The container's init, by store path, baked onto the odu wrapper. */
function tiniStorePath(): string {
  const path = process.env.ODU_LANE_TINI ?? "";
  if (!/^\/nix\/store\/[0-9a-z]{32}-tini-/.test(path)) {
    throw new Error("odu: ODU_LANE_TINI is unset — run odu from its Nix package (it bakes the lane container's init)");
  }
  return path;
}

function workerSourceDir(): string {
  return resolve(import.meta.dirname, "..", "..", "cloudflare-lane");
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? "").split(/\s+/).filter((s) => s !== "");
}

/** Write a credential file 0600 from the moment it exists, and replace any
 *  previous one atomically: a fresh exclusive temp file (`wx`, so a planted
 *  file or symlink at that name is refused, never followed) renamed over the
 *  target. No check-then-act, and no window where the content is readable at
 *  a wider mode. */
function writePrivate(path: string, content: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function readIfPresent(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function ensureSigningKey(dir: string): { secretKeyFile: string; publicKey: string } {
  const secretKeyFile = join(dir, "cloudflare-lane-cache.sec");
  // Read first and act on what was read: the key that is converted is the key
  // that exists, not one that existed when we last looked.
  let secret = readIfPresent(secretKeyFile);
  if (secret === null) {
    const name = `odu-lane-${hostname().split(".")[0]}-1`;
    const generated = execFileSync("nix", ["--extra-experimental-features", "nix-command", "key", "generate-secret", "--key-name", name], { encoding: "utf-8" });
    try {
      // `wx`: if a concurrent setup created the key first, keep theirs.
      writeFileSync(secretKeyFile, generated, { mode: 0o600, flag: "wx" });
      log(`odu: generated lane-cache signing key ${name}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    secret = readFileSync(secretKeyFile);
  }
  const publicKey = execFileSync("nix", ["--extra-experimental-features", "nix-command", "key", "convert-secret-to-public"], {
    input: secret,
    encoding: "utf-8",
  }).trim();
  return { secretKeyFile, publicKey };
}

/** Cloudflare Containers pricing beyond the Workers Paid allowance
 *  (developers.cloudflare.com/containers/pricing, read 2026-10-11): vCPU
 *  $0.000020/s billed on ACTIVE use; memory $0.0000025/GiB-s and disk
 *  $0.00000007/GB-s billed while the instance runs. standard-4 = 4 vCPU,
 *  12 GiB, 20 GB. */
const COST = {
  provisionedPerHour: (12 * 0.0000025 + 20 * 0.00000007) * 3600, // ≈ $0.113
  busyCpuPerHour: 4 * 0.00002 * 3600, // ≈ $0.288 at 100% of 4 vCPU
};

interface SetupOptions {
  maxInstances: number | null;
  s3Cache: string | null;
  noCache: boolean;
  githubToken: boolean | null;
  force: boolean;
}

/** How many containers to allow. A run can ask for one per declared
 *  cloudflare host at once, and the Durable Object names carry a code hash
 *  (worker.ts), so for `sleepAfter` after a redeploy the previous version's
 *  containers still count — hence twice the declared number, never below 8. */
function sizeInstances(explicit: number | null): { max: number; declared: string[]; source: string | null } {
  const { source, hosts } = declaredCloudflareHosts();
  return { max: explicit ?? Math.max(8, 2 * hosts.length), declared: hosts, source };
}

const DATA_PLANE_NAME = "odu-lane-dp";
/** How long after a data-plane deploy attached lanes may still be evicted —
 *  measured drops at 5 and 7.5 min, rounded up with margin. */
const DATA_PLANE_QUIET_MS = 10 * 60_000;

/** The data plane: the Durable Object that owns the containers, and nothing
 *  that changes with configuration (see dataPlane.ts for why). */
function writeDataPlaneConfig(dir: string, maxInstances: number): void {
  const src = join(workerSourceDir(), "src");
  const config = {
    name: DATA_PLANE_NAME,
    main: join(src, "dataPlane.ts"),
    compatibility_date: "2026-09-01",
    // Reachable only through the control plane's Durable Object binding.
    workers_dev: false,
    // bridge.ts and entrypoint.sh travel as TEXT inside the script and are
    // handed to the container as env, so the image stays stock nixos/nix.
    rules: [{ type: "Text", globs: ["**/bridge.ts", "**/entrypoint.sh"], fallthrough: false }],
    observability: { enabled: true },
    containers: [{ class_name: "OduLaneContainer", image: IMAGE, instance_type: INSTANCE_TYPE, max_instances: maxInstances }],
    durable_objects: { bindings: [{ name: "LANE", class_name: "OduLaneContainer" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["OduLaneContainer"] }],
  };
  writeFileSync(join(dir, "wrangler.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/** The control plane: routes, auth, the R2 cache, every secret and setting. */
function writeControlPlaneConfig(
  dir: string,
  opts: { s3Cache: string | null; bun: string; publicKey: string; r2: boolean; dataPlaneVersion: string; legacy: boolean },
): void {
  const src = join(workerSourceDir(), "src");
  const config = {
    name: WORKER_NAME,
    main: join(src, "worker.ts"),
    compatibility_date: "2026-09-01",
    observability: { enabled: true },
    // Its own class name, distinct from the pre-split `OduLane`: Cloudflare
    // refuses to delete a class while any binding names it (code 10061).
    durable_objects: { bindings: [{ name: "DATA_PLANE", class_name: "OduLaneContainer", script_name: DATA_PLANE_NAME }] },
    // A deployment from before the split owned the OduLane class itself;
    // delete it here (its containers were the previous version's anyway).
    ...(opts.legacy
      ? { migrations: [{ tag: "v1", new_sqlite_classes: ["OduLane"] }, { tag: "v2", deleted_classes: ["OduLane"] }] }
      : {}),
    ...(opts.r2 ? { r2_buckets: [{ binding: "CACHE", bucket_name: BUCKET }] } : {}),
    vars: {
      ODU_LANE_DP_VERSION: opts.dataPlaneVersion,
      ODU_LANE_BUN: opts.bun,
      ODU_LANE_TINI: tiniStorePath(),
      ODU_LANE_BASE: (process.env.ODU_LANE_BASE ?? "").split(/\s+/).filter((p) => /^\/nix\/store\/[0-9a-z]{32}-/.test(p)).join(" "),
      ODU_LANE_CACHE_PUBLIC_KEY: opts.publicKey,
      ODU_LANE_CACHE_URL: opts.s3Cache ?? "",
      ODU_LANE_EXTRA_SUBSTITUTERS: splitList(process.env.ODU_AGENT_SUBSTITUTERS).join(" "),
      ODU_LANE_EXTRA_TRUSTED_KEYS: splitList(process.env.ODU_AGENT_TRUSTED_PUBLIC_KEYS).join(" "),
    },
  };
  writeFileSync(join(dir, "wrangler.json"), `${JSON.stringify(config, null, 2)}\n`);
}

/** What a deploy is made of: the generated wrangler config and the sources
 *  wrangler bundles from it. Equal fingerprints mean a deploy would change
 *  nothing. */
function deployFingerprint(dir: string, files: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(join(dir, "wrangler.json")));
  const src = join(workerSourceDir(), "src");
  for (const file of files) hash.update(readFileSync(join(src, file)));
  hash.update(readFileSync(join(workerSourceDir(), "node_modules", "@cloudflare", "containers", "package.json")));
  return hash.digest("hex").slice(0, 16);
}


/** The GitHub token odu already posts statuses with: GH_TOKEN, else the
 *  pinned gh's own login. Returned, never printed. */
function githubToken(): string | null {
  const fromEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  const gh = process.env.ODU_GH_BIN ?? "gh";
  const result = spawnSync(gh, ["auth", "token"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  const token = result.status === 0 ? result.stdout.trim() : "";
  return token === "" ? null : token;
}

function deployDir(): string {
  return join(homedir(), ".cache", "odu", "cloudflare-lane");
}

/** The R2 lane cache is a bucket, and R2 is opt-in per account (a dashboard
 *  click wrangler cannot make: the API answers 10042). Its absence degrades to
 *  shipping the closure through the Worker (shipClosure.ts), not a refusal. */
function ensureBucket(): boolean {
  log(`odu: ensuring R2 bucket ${BUCKET}`);
  try {
    wrangler(["r2", "bucket", "create", BUCKET]);
    return true;
  } catch (error) {
    const output = (error as { output?: string }).output ?? "";
    if (/already exists|already own/i.test(output)) return true;
    if (/enable R2|10042/i.test(output)) {
      log(
        "odu: R2 is not enabled on this Cloudflare account (dashboard → R2 → enable).\n" +
          "     Continuing WITHOUT a lane cache: each cold container is provisioned by shipping\n" +
          "     the runner closure through the Worker. Re-run setup after enabling R2.",
      );
      return false;
    }
    throw error;
  }
}

async function setup(opts: SetupOptions): Promise<number> {
  const configDir = oduConfigDir();
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const dir = deployDir();
  mkdirSync(dir, { recursive: true });

  log("odu: checking wrangler login");
  if (/not authenticated/i.test(wrangler(["whoami"]))) {
    log("odu: wrangler is not logged in — run `wrangler login` (or set CLOUDFLARE_API_TOKEN) and retry");
    return 1;
  }

  const previous = readCloudflareConfig();
  const secret = previous?.secret ?? randomBytes(32).toString("base64url");
  const { secretKeyFile, publicKey } = ensureSigningKey(configDir);
  const bun = bunStorePath();
  const r2 = !opts.noCache && ensureBucket();
  if (!r2 && opts.s3Cache !== null) {
    log("odu: --s3-cache needs R2 enabled on the account");
    return 1;
  }
  const sized = sizeInstances(opts.maxInstances);
  if (sized.declared.length > 0) {
    log(`odu: ${sized.source} declares ${sized.declared.length} cloudflare host(s): ${sized.declared.join(", ")}`);
  }

  // Two scripts (dataPlane.ts explains why). A new version of the DATA plane
  // evicts the Durable Objects carrying attached lanes — measured: dropped
  // ~5 min after the deploy (1006) — so it deploys only when the container
  // code itself changed, and not under a running declared host unless told
  // to. The CONTROL plane holds every setting and secret and redeploys
  // freely: measured, a lane survives it (see the PR's soak).
  const dpDir = join(dir, "dp");
  const cpDir = join(dir, "cp");
  mkdirSync(dpDir, { recursive: true });
  mkdirSync(cpDir, { recursive: true });
  writeDataPlaneConfig(dpDir, sized.max);
  const dataPlaneVersion = deployFingerprint(dpDir, ["dataPlane.ts", "bridge.ts", "entrypoint.sh"]);
  const legacy = previous !== null && previous.dataPlane === undefined;
  if (previous?.dataPlane !== dataPlaneVersion) {
    if (previous !== null && !opts.force) {
      const busy = (await runningHosts(previous, sized.declared)).filter((s) => s.running === true);
      if (busy.length > 0) {
        log(
          `odu: the lane's container code changed, and ${busy.map((s) => s.host).join(", ")} ${busy.length === 1 ? "is" : "are"} running. ` +
            "Deploying it drops their attached lanes ~5 min later (odu re-runs a lane's unfinished nodes). Wait for them to stop (10 min idle), or pass --force.",
        );
        return 1;
      }
    }
    log(`odu: deploying ${DATA_PLANE_NAME} (image ${IMAGE}, ${INSTANCE_TYPE}, max_instances ${sized.max})`);
    wrangler(["deploy"], { cwd: dpDir });
    // Measured: lanes attached to the previous version dropped 5 and 7.5 min
    // after a data-plane deploy. Say when it is safe to start runs again.
    const safe = new Date(Date.now() + DATA_PLANE_QUIET_MS);
    log(
      `odu: ${DATA_PLANE_NAME} deployed. Lanes attached before ${safe.toISOString().slice(11, 16)} UTC may drop ` +
        "(odu re-places them); start new runs after that.",
    );
  } else {
    log(`odu: ${DATA_PLANE_NAME} is current — not redeploying it`);
  }
  // The pre-split container application is bound to the old class, and
  // Cloudflare refuses to delete a class anything still binds (10061).
  if (legacy) deleteLegacyContainerApp();
  writeControlPlaneConfig(cpDir, { s3Cache: opts.s3Cache, bun, publicKey, r2, dataPlaneVersion, legacy });
  const fingerprint = deployFingerprint(cpDir, ["worker.ts", "http.ts"]);
  let url: string;
  if (previous !== null && previous.deployed === fingerprint && !legacy) {
    url = previous.workerUrl;
    log(`odu: ${WORKER_NAME} is current — not redeploying it`);
  } else {
    log(`odu: deploying ${WORKER_NAME}`);
    const deployed = wrangler(["deploy"], { cwd: cpDir });
    const found = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(deployed)?.[0] ?? previous?.workerUrl;
    if (found === undefined) {
      log(deployed);
      log("odu: could not find the Worker URL in wrangler's output");
      return 1;
    }
    url = parseWorkerUrl(found, "wrangler deploy output");
  }
  // The bearer is generated once and kept; it is put only when it is new.
  if (previous === null) wrangler(["secret", "put", "ODU_LANE_SECRET"], { cwd: cpDir, input: secret });

  // GitHub token: an explicit flag decides; otherwise keep what was there.
  let withToken = previous?.githubToken === true;
  if (opts.githubToken === true) {
    const token = githubToken();
    if (token === null) {
      log("odu: --github-token: no GH_TOKEN and `gh auth token` gave none — log gh in first");
      return 1;
    }
    wrangler(["secret", "put", "GITHUB_TOKEN"], { cwd: cpDir, input: token });
    withToken = true;
    log("odu: containers get your GitHub token (as a Worker secret; written to root-only files in the container)");
  } else if (opts.githubToken === false && withToken) {
    wrangler(["secret", "delete", "GITHUB_TOKEN"], { cwd: cpDir, input: "y\n" });
    withToken = false;
    log("odu: removed the GitHub token from the Worker");
  }

  let cache: LaneCacheConfig | null = null;
  if (r2 && opts.s3Cache !== null) {
    const id = process.env.R2_ACCESS_KEY_ID;
    const key = process.env.R2_SECRET_ACCESS_KEY;
    if (id === undefined || key === undefined) {
      log("odu: --s3-cache needs R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (an R2 API token with Object Read & Write on the bucket)");
      return 1;
    }
    const awsCredentialsFile = join(configDir, "cloudflare-r2.credentials");
    writePrivate(awsCredentialsFile, `[default]\naws_access_key_id = ${id}\naws_secret_access_key = ${key}\n`);
    wrangler(["secret", "put", "AWS_ACCESS_KEY_ID"], { cwd: cpDir, input: id });
    wrangler(["secret", "put", "AWS_SECRET_ACCESS_KEY"], { cwd: cpDir, input: key });
    cache = { url: opts.s3Cache, secretKeyFile, publicKey, netrcFile: null, awsCredentialsFile };
  } else if (r2) {
    const netrcFile = join(configDir, "cloudflare-lane.netrc");
    writePrivate(netrcFile, `machine ${new URL(url).hostname} login odu password ${secret}\n`);
    cache = { url: `${url}/nix-cache`, secretKeyFile, publicKey, netrcFile, awsCredentialsFile: null };
  }

  const config: CloudflareConfig = {
    workerUrl: url,
    secret,
    cache,
    maxInstances: sized.max,
    deployed: fingerprint,
    dataPlane: dataPlaneVersion,
    ...(withToken ? { githubToken: true } : {}),
  };
  writePrivate(cloudflareConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
  log(`odu: wrote ${cloudflareConfigPath()}`);
  log(`odu: ${WORKER_NAME} is at ${url}; lane cache: ${cache === null ? "none (closure ships through the Worker)" : cache.url}`);
  log('odu: use it with --host x86_64-linux=cloudflare, or {"x86_64-linux": {"host": "cloudflare", "slots": 4}} in hosts.json');
  log(`odu: cost: ~$${COST.provisionedPerHour.toFixed(2)}/h per running container + up to $${COST.busyCpuPerHour.toFixed(2)}/h CPU while busy; idle containers stop after 10 min`);
  return 0;
}

function requireConfig(): Readonly<CloudflareConfig> | null {
  const config = readCloudflareConfig();
  if (config === null) log(`odu: no ${cloudflareConfigPath()} — run \`odu cloudflare setup\``);
  return config;
}

/** Per-host state from each Durable Object — never starts a container. */
async function runningHosts(
  config: Readonly<CloudflareConfig>,
  hosts: readonly string[],
): Promise<{ host: string; running: boolean | null; kvm: boolean | null; diskFreeGiB: number | null; inodesFreePercent: number | null }[]> {
  return Promise.all(
    hosts.map(async (host) => {
      const state = await fetch(laneEndpoint(config, cloudflareInstance(host), "state"), {
        headers: laneAuthHeaders(config),
        signal: AbortSignal.timeout(15_000),
      })
        .then((r) => (r.ok ? (r.json() as Promise<{ running?: boolean; kvm?: boolean | null; disk?: { freeBytes: number; freeInodes?: number; totalInodes?: number } | null }>) : null))
        .catch(() => null);
      const free = state?.disk?.freeBytes;
      const inodes = state?.disk?.freeInodes !== undefined && state.disk.totalInodes ? Math.round((100 * state.disk.freeInodes) / state.disk.totalInodes) : null;
      return {
        host,
        running: state === null ? null : state.running === true,
        kvm: state?.kvm ?? null,
        diskFreeGiB: typeof free === "number" ? Number((free / 1024 ** 3).toFixed(1)) : null,
        inodesFreePercent: inodes,
      };
    }),
  );
}

async function status(json: boolean): Promise<number> {
  const config = requireConfig();
  if (config === null) return 1;
  const health = await fetch(new URL("/healthz", config.workerUrl), { signal: AbortSignal.timeout(15_000) }).then(
    (r) => r.status,
    () => 0,
  );
  const { source, hosts } = declaredCloudflareHosts();
  const states = await runningHosts(config, hosts);
  const running = states.filter((s) => s.running === true).length;
  const report = {
    workerUrl: config.workerUrl,
    healthz: health,
    cache: config.cache?.url ?? null,
    githubToken: config.githubToken === true,
    maxInstances: config.maxInstances ?? null,
    hostsFile: source,
    hosts: states,
    costPerHourNow: {
      provisioned: Number((running * COST.provisionedPerHour).toFixed(3)),
      cpuIfBusy: Number((running * COST.busyCpuPerHour).toFixed(3)),
    },
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `odu-lane  ${config.workerUrl}  healthz ${health}\n` +
        `cache     ${report.cache ?? "none (closure ships through the Worker)"}\n` +
        `github    ${report.githubToken ? "token installed" : "no token (public origins only)"}\n` +
        `capacity  max_instances ${report.maxInstances ?? "unknown"}; ${hosts.length} cloudflare host(s) in ${source ?? "no hosts file"}\n` +
        states
          .map((s) => `  ${s.host.padEnd(28)} ${s.running === null ? "unknown" : s.running ? `running  KVM: ${s.kvm === true ? "yes" : s.kvm === false ? "NO" : "?"}  disk free: ${s.diskFreeGiB ?? "?"} GiB, ${s.inodesFreePercent ?? "?"}% inodes` : "stopped"}\n`)
          .join("") +
        `cost now  ${running} running: ~$${report.costPerHourNow.provisioned}/h + up to $${report.costPerHourNow.cpuIfBusy}/h CPU while busy\n`,
    );
  }
  const needed = 2 * hosts.length;
  if (config.maxInstances !== undefined && needed > config.maxInstances) {
    log(`odu: hosts declare ${hosts.length} containers but max_instances is ${config.maxInstances} — re-run \`odu cloudflare setup\``);
    return 1;
  }
  return health === 200 ? 0 : 1;
}

async function destroy(instance: string): Promise<number> {
  const config = requireConfig();
  if (config === null) return 1;
  const response = await fetch(laneEndpoint(config, instance, "destroy"), {
    method: "POST",
    headers: laneAuthHeaders(config),
    signal: AbortSignal.timeout(60_000),
  });
  log(`odu: ${instance}: ${response.status} ${(await response.text()).trim()}`);
  return response.ok ? 0 : 1;
}

async function confirm(question: string, expected: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim() === expected;
  } finally {
    rl.close();
  }
}

/** Before the split, `odu-lane` owned a container application of its own;
 *  its class is gone after the migration, so its application goes too. */
function deleteLegacyContainerApp(): void {
  const apps = JSON.parse(wrangler(["containers", "list", "--json"]).replace(/^[^[]*/s, "")) as { id: string; name: string }[];
  for (const app of apps.filter((a) => a.name === `${WORKER_NAME}-odulane`)) {
    try {
      wrangler(["containers", "delete", app.id], { input: "y\n" });
      log(`odu: deleted the pre-split container application ${app.name}`);
    } catch {
      log(`odu: could not delete ${app.name} — remove it with \`wrangler containers delete ${app.id}\``);
    }
  }
}

/** Remove everything setup created, account side and local. Ordered so a
 *  failure part-way leaves something `teardown` can be re-run against: the
 *  bucket is emptied through the Worker while it still exists, then the
 *  Worker, its container application, the bucket, and last the local files. */
async function teardown(yes: boolean): Promise<number> {
  if (!yes) {
    const ok = await confirm(
      `This deletes the ${WORKER_NAME} and ${DATA_PLANE_NAME} Workers, their containers, the R2 bucket ${BUCKET} and your local odu-lane credentials.\nType ${WORKER_NAME} to confirm: `,
      WORKER_NAME,
    );
    if (!ok) {
      log("odu: not confirmed (pass --yes when not at a terminal) — nothing deleted");
      return 1;
    }
  }
  const config = readCloudflareConfig();
  if (config?.cache !== null && config !== null) {
    for (let more = true; more; ) {
      const response = await fetch(new URL("/nix-cache-purge", config.workerUrl), {
        method: "POST",
        headers: laneAuthHeaders(config),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`odu: emptying ${BUCKET} failed: ${response.status}`);
      const body = (await response.json()) as { deleted: number; more: boolean };
      log(`odu: emptied ${body.deleted} object(s) from ${BUCKET}`);
      more = body.more;
    }
  }
  const step = (what: string, args: string[], absent: RegExp): void => {
    try {
      wrangler(args, { input: "y\n" });
      log(`odu: deleted ${what}`);
    } catch (error) {
      const output = (error as { output?: string }).output ?? "";
      if (!absent.test(output)) throw error;
      log(`odu: ${what} already gone`);
    }
  };
  step(`Worker ${WORKER_NAME}`, ["delete", "--name", WORKER_NAME, "--force"], /not found|does not exist|10007/i);
  step(`Worker ${DATA_PLANE_NAME}`, ["delete", "--name", DATA_PLANE_NAME, "--force"], /not found|does not exist|10007/i);
  const apps = JSON.parse(wrangler(["containers", "list", "--json"]).replace(/^[^[]*/s, "")) as { id: string; name: string }[];
  for (const app of apps.filter((a) => a.name.startsWith(`${WORKER_NAME}-`))) {
    step(`container application ${app.name}`, ["containers", "delete", app.id], /not found/i);
  }
  step(`R2 bucket ${BUCKET}`, ["r2", "bucket", "delete", BUCKET], /not found|does not exist|10006|enable R2/i);
  for (const file of ["cloudflare.json", "cloudflare-lane.netrc", "cloudflare-lane-cache.sec", "cloudflare-r2.credentials"]) {
    rmSync(join(oduConfigDir(), file), { force: true });
  }
  rmSync(deployDir(), { recursive: true, force: true });
  log("odu: removed local odu-lane credentials; nothing of odu-lane remains on the account");
  return 0;
}

export async function cloudflareCommand(args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "setup": {
      const { values } = parseArgs({
        args: [...rest],
        options: {
          "max-instances": { type: "string" },
          "s3-cache": { type: "string" },
          "no-cache": { type: "boolean" },
          "github-token": { type: "boolean" },
          "no-github-token": { type: "boolean" },
          force: { type: "boolean" },
        },
      });
      let maxInstances: number | null = null;
      if (values["max-instances"] !== undefined) {
        maxInstances = Number(values["max-instances"]);
        if (!Number.isInteger(maxInstances) || maxInstances < 1) {
          log("odu: --max-instances needs a positive integer");
          return 2;
        }
      }
      if (values["github-token"] === true && values["no-github-token"] === true) {
        log("odu: --github-token and --no-github-token contradict each other");
        return 2;
      }
      return setup({
        maxInstances,
        s3Cache: values["s3-cache"] ?? null,
        noCache: values["no-cache"] ?? false,
        githubToken: values["github-token"] === true ? true : values["no-github-token"] === true ? false : null,
        force: values.force === true,
      });
    }
    case "status": {
      const { values } = parseArgs({ args: [...rest], options: { output: { type: "string", short: "o" } } });
      return status(values.output === "json");
    }
    case "destroy":
      return destroy(rest[0] ?? "default");
    case "teardown": {
      const { values } = parseArgs({ args: [...rest], options: { yes: { type: "boolean" } } });
      return teardown(values.yes === true);
    }
    default:
      process.stderr.write(USAGE);
      return sub === undefined || sub === "help" || sub === "--help" ? 0 : 2;
  }
}
