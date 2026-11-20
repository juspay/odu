import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pushToCache, type PushFailure, type PushSummary } from "@odu/cache/push";

export interface PushConfig {
  readonly origin: string;
  readonly bucket: string;
  readonly token: string;
  readonly pin?: string;
  readonly run?: string;
  readonly commit?: string;
}

export const PUSH_ORIGIN_ENV = "ODU_CACHE_ORIGIN";
export const PUSH_BUCKET_ENV = "ODU_CACHE_BUCKET";
export const PUSH_TOKEN_ENV = "ODU_CACHE_TOKEN";
export const PUSH_PIN_ENV = "ODU_CACHE_PIN";
export const PUSH_RUN_ENV = "ODU_CACHE_RUN";
export const PUSH_COMMIT_ENV = "ODU_CACHE_COMMIT";

export function pushEnvFor(
  config: PushConfig | null,
): Readonly<Record<string, string>> {
  return config === null
    ? {}
    : {
        [PUSH_ORIGIN_ENV]: config.origin,
        [PUSH_BUCKET_ENV]: config.bucket,
        [PUSH_TOKEN_ENV]: config.token,
        ...(config.pin === undefined ? {} : { [PUSH_PIN_ENV]: config.pin }),
        ...(config.run === undefined ? {} : { [PUSH_RUN_ENV]: config.run }),
        ...(config.commit === undefined
          ? {}
          : { [PUSH_COMMIT_ENV]: config.commit }),
      };
}

export function pushConfigOf(
  env: Readonly<Record<string, string>> | undefined,
): PushConfig | null {
  const origin = env?.[PUSH_ORIGIN_ENV];
  const bucket = env?.[PUSH_BUCKET_ENV];
  const token = env?.[PUSH_TOKEN_ENV];
  if (origin === undefined || origin === "") return null;
  if (bucket === undefined || bucket === "") return null;
  if (token === undefined || token === "") return null;
  const pin = env?.[PUSH_PIN_ENV];
  const run = env?.[PUSH_RUN_ENV];
  const commit = env?.[PUSH_COMMIT_ENV];
  return {
    origin,
    bucket,
    token,
    ...(pin === undefined || pin === "" ? {} : { pin }),
    ...(run === undefined || run === "" ? {} : { run }),
    ...(commit === undefined || commit === "" ? {} : { commit }),
  };
}

export interface PushedFact {
  stored: number;
  present: number;
  bytes: number;
}

export function resultPathsIn(workspace: string, storeDir: string = nixStoreDir()): string[] {
  const entries = readdirSync(workspace);
  const resolved: string[] = [];
  for (const entry of entries.sort()) {
    if (!entry.startsWith("result")) continue;
    const target = storePathOfLink(join(workspace, entry), storeDir);
    if (target === null || resolved.includes(target)) continue;
    resolved.push(target);
  }
  return resolved;
}

function storePathOfLink(link: string, storeDir: string): string | null {
  const prefix = storeDir.endsWith("/") ? storeDir : `${storeDir}/`;
  try {
    const target = realpathSync(link);
    if (!target.startsWith(prefix)) return null;
    if (!existsSync(target)) return null;
    return target;
  } catch {
    return null;
  }
}

const DEFAULT_NIX_STORE_DIR = "/nix/store";

function nixStoreDir(): string {
  const declared = process.env.NIX_STORE_DIR?.trim();
  return declared === undefined || declared === ""
    ? DEFAULT_NIX_STORE_DIR
    : declared;
}

function pathsToSend(
  config: PushConfig,
  found: readonly string[],
  sent: ReadonlySet<string>,
): string[] {
  return config.pin === undefined
    ? found.filter((path) => !sent.has(path))
    : [...found];
}

export interface LanePusher {
  push(
    workdir: string,
    config: PushConfig,
    hooks: {
      note: (line: string) => void;
      begin: () => void;
      say: (line: string) => void;
    },
  ): Promise<PushedFact | null>;
}

export function createLanePusher(
  deps: {
    push?: typeof pushToCache;
    storeDir?: string;
  } = {},
): LanePusher {
  const send = deps.push ?? pushToCache;
  const sent = new Set<string>();
  const rememberServed = (summary: PushSummary): void => {
    for (const path of summary.served) sent.add(path);
  };

  return {
    async push(workdir, config, hooks) {
      let found: string[];
      try {
        found = resultPathsIn(workdir, deps.storeDir);
      } catch (err) {
        hooks.note(
          `[odu] not pushing: ${workdir} could not be read ` +
            `(${err instanceof Error ? err.message : String(err)})`,
        );
        return null;
      }
      const sending = pathsToSend(config, found, sent);
      if (sending.length === 0) return null;
      hooks.begin();
      hooks.say(
        `[odu] pushing ${sending.length} result path${sending.length === 1 ? "" : "s"} ` +
          `to bucket ${config.bucket} at ${config.origin}`,
      );
      let summary: PushSummary;
      try {
        summary = await send({
          bucket: config.bucket,
          origin: config.origin,
          paths: sending,
          credential: config.token,
          ...(config.pin === undefined ? {} : { pin: config.pin }),
          ...(config.run === undefined ? {} : { run: config.run }),
          ...(config.commit === undefined ? {} : { commit: config.commit }),
          env: {},
          onLine: (line) => hooks.say(`[odu] ${line}`),
        });
      } catch (err) {
        throw new Error(
          `odu: push of ${sending.length} path${sending.length === 1 ? "" : "s"} ` +
            `to bucket ${config.bucket} at ${config.origin} failed`,
          { cause: err },
        );
      }
      rememberServed(summary);
      assertNoFailures(summary, config);
      return { stored: summary.pushed, present: summary.alreadyPresent, bytes: summary.bytes };
    },
  };
}

function assertNoFailures(summary: PushSummary, config: PushConfig): void {
  if (summary.failed === 0) return;
  throw new Error(
    `odu: ${summary.failed} path${summary.failed === 1 ? "" : "s"} could not be ` +
      `pushed to ${config.bucket} at ${config.origin} — ` +
      summary.failures.map(refusalLine).join("; "),
  );
}

function refusalLine(failure: PushFailure): string {
  const last = failure.attempts.at(-1);
  const facts =
    last === undefined
      ? []
      : [
          last.url === null ? null : `url=${last.url}`,
          last.status === null ? null : `status=${last.status}`,
          last.body === null || last.body === "" ? null : `body=${last.body}`,
        ].filter((fact): fact is string => fact !== null);
  return facts.length === 0
    ? `${failure.path}: ${failure.message}`
    : `${failure.path}: ${failure.message} (${facts.join(", ")})`;
}
