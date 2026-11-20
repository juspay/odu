import { statfs } from "node:fs/promises";
import { join } from "node:path";
import type {
  BucketGauge,
  BucketRow,
  BucketTotals,
  MigrationRow,
  ObjectRow,
  PinAuthor,
  Scope,
  TokenRow,
  PathSort,
} from "./db";
import { openCacheRepo } from "./db";
import {
  closureOf,
  type GcBucketPlan,
  type GcCollection,
  type GcRemoval,
  GC_PREVIEW_PATHS,
  type GcPreview,
  type Hold,
  holdsOf,
  keptBy,
  longestHeld,
  planGc,
  previewGc,
  runGc,
  sweepOrphans,
} from "./gc";
import { migrationKeys, runMigration } from "./migrateStore";
import { purgeKeys } from "./purge";
import {
  fingerprintOf,
  formatNarinfo,
  generateKeypair,
  isDerivationPath,
  isStorePathHash,
  keyNameOf,
  compressionOfFile,
  canonicalNarHash,
  type NarInfo,
  narFileName,
  signFingerprint,
  storePathHash,
} from "./narinfo";
import { newChain, serial } from "./serial";
import { CACHE_MOUNT, type Provenance } from "./paths";
import {
  type CacheKeptBy,
  LOCAL_STORE,
  PATH_PAGE_SIZE,
  PRESIGN_SECONDS,
  storePathParts,
} from "./surface";
import {
  cacheInfoKey,
  CACHE_INFO_CONTENT_TYPE,
  createStaging,
  INFO_CACHE_CONTROL,
  NAR_CACHE_CONTROL,
  NAR_CONTENT_TYPE,
  narinfoKey,
  NARINFO_CONTENT_TYPE,
  nixCacheInfo,
  objectKey,
  type CompleteUpload,
  type DirectComplete,
  type DirectPart,
  type NarinfoOutcome,
  type Upload,
  type UploadMode,
  type UploadPlan,
} from "./staging";
import {
  type ByteRange,
  factsCounter,
  type ObjectFacts,
  type ObjectStore,
  type PutOutcome,
  sameFacts,
  type UploadedPart,
} from "@odu/objects";
import { type KeptFile, keptFileOf } from "./fileHash";
import { contentAddressOf, type SelfHashes } from "./storePath";
import { verifyNarStream } from "./store";
import { createSlots } from "./slots";
import {
  globMatches,
  hashToken,
  mintToken,
  mintTokenId,
  rootTokenMatches,
  type TokenFacts,
  tokenFacts,
  verifyToken,
} from "./tokens";

export interface BucketFacts {
  name: string;
  public: boolean;
  retentionDays: number;
  keyName: string;
  publicKey: string;
  upstreamKeys: readonly string[];
  domain: string | null;
  objects: number;
  bytes: number;
  created: number;
  lastPush: number | null;
  hits: number;
  store: string;
  writesTo: "store" | "odu";
  migration: MigrationFacts | null;
}

export interface MigrationFacts {
  to: string;
  state: "copying" | "flipping" | "deleting";
  copied: number;
  total: number;
  bytes: number;
}

export interface BucketIdentity {
  name: string;
  public: boolean;
  publicKey: string;
  domain: string | null;
  store: string;
}

export interface TokenMinted {
  token: string;
  facts: TokenFacts;
}

export interface PinFacts {
  bucket: string;
  name: string;
  rootPaths: readonly string[];
  created: number;
  createdBy: PinAuthor;
}

export interface CacheStats {
  buckets: readonly BucketFacts[];
  objects: number;
  bytes: number;
  hits: number;
  lastWanted: number | null;
}

export type CacheRefusalCode =
  | "no_root_token"
  | "unknown_bucket"
  | "bucket_exists"
  | "bad_input"
  | "not_permitted"
  | "unknown_store";

export type CacheOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: CacheRefusalCode; message: string };

const roleSeal: unique symbol = Symbol("odu:cache/role");

export type Authority =
  | { readonly kind: "root"; readonly rootToken: string }
  | { readonly kind: "role"; readonly login: string; readonly [roleSeal]: true };

export function roleAuthority(login: string): Authority {
  return { kind: "role", login, [roleSeal]: true };
}

export interface CacheAdmin {
  readonly mount: string;
  create(input: { authority: Authority;
    name: string;
    public: boolean;
    retentionDays: number;
    upstreamKeys: readonly string[];
    store?: string;
  }): Promise<CacheOutcome<BucketFacts>>;
  list(input: { authority: Authority }): Promise<CacheOutcome<readonly BucketFacts[]>>;
  describe(input: { bucket: string }): Promise<CacheOutcome<BucketIdentity>>;
  domain(input: {
    authority: Authority;
    bucket: string;
    domain: string | null;
  }): Promise<CacheOutcome<BucketFacts>>;
  tokenMint(input: { authority: Authority;
    bucket: string;
    bucketGlob: string | null;
    scope: Scope;
    expiresDays: number | null;
  }): Promise<CacheOutcome<TokenMinted>>;
  tokenList(input: { authority: Authority;
    bucket: string | null;
  }): Promise<CacheOutcome<readonly TokenFacts[]>>;
  tokenRevoke(input: { authority: Authority;
    id: string;
  }): Promise<CacheOutcome<{ id: string; revoked: boolean }>>;
  retention(input: {
    authority: Authority;
    bucket: string;
    retentionDays: number;
  }): Promise<CacheOutcome<BucketFacts>>;
  migrateStore(input: {
    authority: Authority;
    bucket: string;
    store: string;
  }): Promise<CacheOutcome<BucketFacts>>;
  bucketDelete(input: {
    authority: Authority;
    bucket: string;
  }): Promise<CacheOutcome<BucketDeleted>>;
  pin(input: { authority: Authority;
    bucket: string;
    name: string;
    paths: readonly string[];
  }): Promise<CacheOutcome<PinFacts>>;
  pinList(input: {
    authority: Authority;
    bucket: string;
  }): Promise<CacheOutcome<readonly PinFacts[]>>;
  pinDelete(input: {
    authority: Authority;
    bucket: string;
    name: string;
  }): Promise<CacheOutcome<{ bucket: string; name: string }>>;
  gc(input: {
    authority: Authority;
    bucket: string | null;
  }): Promise<CacheOutcome<GcCollection>>;
  gcPlan(input: {
    authority: Authority;
    bucket: string | null;
    retentionDays: number | null;
  }): Promise<CacheOutcome<GcPreview>>;
  stats(input: { authority: Authority }): Promise<CacheOutcome<CacheStats>>;
  paths(input: {
    bucket: string;
    filter: string | null;
    after: string | null;
    group?: "name" | null;
    name?: string | null;
    sort?: PathSort | null;
    descending?: boolean | null;
  }): Promise<
    CacheOutcome<{
      paths: readonly PathPageRow[];
      groups: readonly PathGroupPageRow[] | null;
      next: string | null;
    }>
  >;
}

export interface BucketDeleted {
  name: string;
  objects: number;
  bytes: number;
}

export interface PathPageRow {
  storePath: string;
  narSize: number;
  created: number;
  hits: number;
  lastWanted: number;
  run: string | null;
  commit: string | null;
  keptBy: CacheKeptBy;
}

export interface PathGroupPageRow {
  name: string;
  versions: number;
  bytes: number;
  hits: number;
  pushed: number;
  wanted: number;
  storePath: string;
  run: string | null;
  commit: string | null;
  keptBy: CacheKeptBy;
}

export type AuthVerdict = { ok: true } | { ok: false; status: 401 | 403 | 404; message: string };

export type NarSource =
  | {
      kind: "object";
      storePath: string;
      size: number;
      read(range?: ByteRange): Promise<ReadableStream<Uint8Array> | null>;
    }
  | { kind: "legacy"; storePath: string; stream: ReadableStream<Uint8Array> }
  | { kind: "redirect"; storePath: string; size: number; url: URL };

export type CacheMountRefusal = {
  kind: "undeclared_store";
  bucket: string;
  store: string;
  declared: readonly string[];
};

export function mountRefusalMessage(refusal: CacheMountRefusal): string {
  return (
    `the bucket "${refusal.bucket}" keeps its objects in the store "${refusal.store}", ` +
    `which this daemon does not declare (declared: ${refusal.declared.join(", ")}) — ` +
    "declare it again, or the bucket's objects cannot be served"
  );
}

export interface BootReport {
  caProved: number;
  orphansSwept: number;
  tempSwept: number;
}

export interface SelfProofReport {
  rows: number;
  proved: number;
  refused: number;
  unreadable: number;
  skipped: number;
}

export interface ObjectBackfillReport {
  rows: number;
  written: number;
  failures: number;
}

export interface MigrationReport {
  migrated: number;
  failures: number;
  complete: boolean;
  paused: string | null;
}

export interface Cache {
  bucket(name: string): BucketRow | null;
  bucketByDomain(host: string): BucketRow | null;
  authorize(header: string | undefined, bucket: BucketRow, need: Scope): AuthVerdict;
  narinfoText(bucket: BucketRow, hash: string): string | null;
  cacheInfoText(bucket: string): string;
  touch(bucket: BucketRow, hash: string): void;
  log(event: string, fields: Record<string, unknown>): void;
  narSource(bucket: BucketRow, file: string): Promise<NarSource | null>;
  beginDirect(bucket: BucketRow, file: string, floor: number | null): Promise<UploadPlan>;
  directPart(bucket: BucketRow, file: string, upload: string, index: number): Promise<DirectPart>;
  completeDirect(
    bucket: BucketRow,
    file: string,
    upload: string,
    parts: readonly UploadedPart[],
  ): Promise<DirectComplete>;
  beginUpload(bucket: BucketRow, file: string): Promise<Upload>;
  beginPart(
    bucket: BucketRow,
    file: string,
    index: number,
    limit: number,
    session?: string | null,
  ): Promise<Upload>;
  completeUpload(
    bucket: BucketRow,
    file: string,
    total: number,
    session?: string | null,
  ): Promise<CompleteUpload>;
  acceptNarinfo(
    bucket: BucketRow,
    hash: string,
    body: ReadableStream<Uint8Array>,
    provenance: Provenance,
  ): Promise<NarinfoOutcome>;
  missing(
    bucket: BucketRow,
    paths: readonly { path: string; sigs?: readonly string[] }[],
    provenance: Provenance,
    whole: boolean,
  ): { missing: readonly string[]; skipped: readonly string[] };
  snapshot(): readonly BucketFacts[];
  meterGauges(): readonly BucketGauge[];
  onChange(listener: () => void): () => void;
  collect(): Promise<GcCollection>;
  pinAs(
    bucket: BucketRow,
    input: { name: string; paths: readonly string[] },
  ): Promise<CacheOutcome<PinFacts>>;
  grantRunToken(request: { bucket: string; runId: string }): { id: string; token: string } | null;
  revokeToken(id: string): void;
  admin: CacheAdmin;
  boot(): Promise<{ ok: true; report: BootReport } | { ok: false; refusal: CacheMountRefusal }>;
  proveSelf(): Promise<SelfProofReport>;
  migrate(): Promise<MigrationReport>;
  backfillObjects(): Promise<ObjectBackfillReport>;
  resumeMigrations(): Promise<void>;
  close(): Promise<void>;
}

export interface CacheOptions {
  stateRoot: string;
  rootToken: string | null;
  publicOrigin: string;
  legacyStore?: {
    dump(storePath: string): ReadableStream<Uint8Array>;
    pathInfo?(storePath: string): Promise<{ ca: string | null; narHash: string } | null>;
  } | null;
  migrationFreeFloor?: number;
  migrationRetryMs?: number;
  freeBytes?: () => Promise<number | null>;
  stores: ReadonlyMap<string, ObjectStore>;
  frontedStores?: ReadonlySet<string>;
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
  purged?: (input: {
    bucket: string;
    store: string;
    reason: "migrate" | "repush" | "delete";
    removals: readonly GcRemoval[];
    cacheInfo?: boolean;
  }) => void;
}

export const HITS_REFRESH_MS = 1000;

export const RUN_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

export { PRESIGN_SECONDS } from "./surface";

const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function checkedDays(days: number | null): CacheOutcome<null> {
  if (days !== null && (!Number.isSafeInteger(days) || days < 0)) {
    return {
      ok: false,
      code: "bad_input",
      message: "retention must be a whole number of days, zero or more",
    };
  }
  return { ok: true, value: null };
}

export function createCache(options: CacheOptions): Cache {
  const now = options.now ?? (() => Date.now());
  const dir = join(options.stateRoot, "cache");
  const repo = openCacheRepo(join(dir, "cache.sqlite"));
  const { stores } = options;
  const fronted = options.frontedStores ?? new Set<string>();
  const storeOf = (bucket: Pick<BucketRow, "name" | "store">): ObjectStore => {
    const store = stores.get(bucket.store);
    if (store === undefined) throw new Error(`bucket "${bucket.name}" names an undeclared store`);
    return store;
  };
  const objectsOf = (name: string): ObjectStore => {
    const bucket = repo.bucket(name);
    if (bucket === null) throw new Error(`no bucket "${name}"`);
    return storeOf(bucket);
  };

  const writers = newChain();
  const withWriteLock = <T>(work: () => Promise<T>): Promise<T> => serial(writers, work);

  const holdsMemo = new Map<
    string,
    { revision: number; holds: Map<string, Hold>; byName: Map<string, string[]> }
  >();
  function holdsFor(bucket: BucketRow): {
    holds: Map<string, Hold>;
    byName: Map<string, string[]>;
  } {
    const revision = repo.revision(bucket.name);
    const kept = holdsMemo.get(bucket.name);
    if (kept !== undefined && kept.revision === revision) return kept;
    const objects = repo.objects(bucket.name);
    const holds = holdsOf(bucket, objects, repo.pins(bucket.name));
    const byName = new Map<string, string[]>();
    for (const row of objects) {
      const name = storePathParts(row.storePath).name;
      const versions = byName.get(name);
      if (versions === undefined) byName.set(name, [row.storePath]);
      else versions.push(row.storePath);
    }
    const fresh = { revision, holds, byName };
    holdsMemo.set(bucket.name, fresh);
    return fresh;
  }

  function requireRoot(input: { authority: Authority }): CacheOutcome<null> {
    if (input.authority.kind === "role") {
      if (roleSeal in input.authority && input.authority[roleSeal] === true) {
        return { ok: true, value: null };
      }
      return {
        ok: false,
        code: "no_root_token",
        message: "this authority was not minted by the cache row",
      };
    }
    if (!rootTokenMatches(options.rootToken, input.authority.rootToken)) {
      return {
        ok: false,
        code: "no_root_token",
        message:
          options.rootToken === null
            ? "this service was started without a root token, so no cache " +
              "administration is possible — set $ODU_ROOT_TOKEN and restart it"
            : "the root token does not match this service's $ODU_ROOT_TOKEN",
      };
    }
    return { ok: true, value: null };
  }

  const exposure = (isPublic: boolean, store: string): CacheOutcome<never> | null =>
    isPublic || !fronted.has(store)
      ? null
      : {
          ok: false,
          code: "bad_input",
          message:
            `the store "${store}" publishes its objects at a public URL, so a private ` +
            "bucket on it would be readable by anyone who knows its name — make the " +
            "bucket public, or choose a store with no publicUrl",
        };

  const migrationFactsOf = (bucket: string): MigrationFacts | null => {
    const row = repo.migration(bucket);
    return row === null
      ? null
      : { to: row.toStore, state: row.state, copied: row.copied, total: row.total, bytes: row.bytes };
  };

  type WriteOutcome = "written" | "same" | "rewritten";

  function factsOf(
    bucket: BucketRow,
    counted: Map<string, BucketTotals> = repo.bucketStats(),
  ): BucketFacts {
    const counts = counted.get(bucket.name);
    return {
      name: bucket.name,
      public: bucket.isPublic,
      retentionDays: bucket.retentionDays,
      keyName: bucket.keyName,
      publicKey: bucket.publicKey,
      upstreamKeys: bucket.upstreamKeys,
      domain: bucket.domain,
      objects: counts?.objects ?? 0,
      bytes: counts?.bytes ?? 0,
      created: bucket.created,
      lastPush: counts?.lastPush ?? null,
      hits: counts?.hits ?? 0,
      store: bucket.store,
      writesTo: staging.uploadMode(bucket) === "direct" ? "store" : "odu",
      migration: migrationFactsOf(bucket.name),
    };
  }

  function signatureOf(bucket: BucketRow, row: ObjectRow): string {
    return signFingerprint(
      bucket.secretKey,
      fingerprintOf({
        storePath: row.storePath,
        narHash: row.narHash,
        narSize: row.narSize,
        references: row.references,
      }),
    );
  }

  function narinfoFor(bucket: BucketRow, row: ObjectRow): string {
    const info: NarInfo = {
      storePath: row.storePath,
      url: `nar/${narFileName(row.narHash, row.compression)}`,
      compression: row.compression,
      fileHash: row.fileHash,
      fileSize: row.fileSize,
      narHash: row.narHash,
      narSize: row.narSize,
      references: row.references,
      deriver: row.deriver,
      ca: row.caProof === "content-addressed" ? row.ca : null,
      sigs: [signatureOf(bucket, row), ...row.sigs],
    };
    return formatNarinfo(info);
  }

  async function writeText(
    objects: ObjectStore,
    key: string,
    text: string,
    contentType: string,
  ): Promise<WriteOutcome> {
    const bytes = new TextEncoder().encode(text);
    const counter = factsCounter();
    counter.update(bytes);
    const facts = counter.facts();
    const put = (): Promise<PutOutcome> =>
      objects.put(key, new Blob([bytes]), facts, {
        contentType,
        cacheControl: INFO_CACHE_CONTROL,
      });
    const first = await put();
    if (first.ok) return "written";
    if (first.refusal.kind === "exists" && sameFacts(first.refusal.facts, facts)) return "same";
    await objects.delete(key);
    const again = await put();
    if (!again.ok) throw new Error(`${key} could not be written: ${again.refusal.kind}`);
    return "rewritten";
  }

  async function keepTextObject(
    bucket: BucketRow,
    what: { key: string; text: string; contentType: string },
  ): Promise<WriteOutcome | "failed"> {
    try {
      return await writeText(storeOf(bucket), what.key, what.text, what.contentType);
    } catch (err) {
      options.log?.("cache.narinfo.object_failed", {
        bucket: bucket.name,
        path: what.key,
        reason: String((err as Error).message ?? err),
      });
      return "failed";
    }
  }

  async function keepNarinfoObject(
    bucket: BucketRow,
    row: ObjectRow,
  ): Promise<WriteOutcome | "failed"> {
    const outcome = await keepTextObject(bucket, {
      key: narinfoKey(bucket.name, row.hash),
      text: narinfoFor(bucket, row),
      contentType: NARINFO_CONTENT_TYPE,
    });
    if (outcome === "rewritten") {
      options.purged?.({
        bucket: bucket.name,
        store: bucket.store,
        reason: "repush",
        removals: [{ storePath: row.storePath, hash: row.hash, narFile: null }],
      });
    }
    return outcome;
  }

  const cacheInfoText = (bucket: string): string =>
    nixCacheInfo({ origin: options.publicOrigin, bucket });

  async function keepCacheInfoObject(bucket: BucketRow): Promise<void> {
    const outcome = await keepTextObject(bucket, {
      key: cacheInfoKey(bucket.name),
      text: cacheInfoText(bucket.name),
      contentType: CACHE_INFO_CONTENT_TYPE,
    });
    if (outcome === "rewritten") {
      options.purged?.({
        bucket: bucket.name,
        store: bucket.store,
        reason: "repush",
        removals: [],
        cacheInfo: true,
      });
    }
  }

  async function recordNow(
    bucket: BucketRow,
    info: NarInfo,
    file: KeptFile,
    selfHash: SelfHashes | null,
    provenance: Provenance,
  ): Promise<boolean> {
    const existing = repo.object(bucket.name, info.storePath);
    const at = now();
    const sigs = [...new Set(info.sigs)].filter((sig) => keyNameOf(sig) !== bucket.keyName);
    const computed = contentAddressOf({
      storePath: info.storePath,
      narHash: info.narHash,
      references: info.references,
      selfHash,
    });
    const unjudged =
      computed === null && selfHash === null && info.references.includes(info.storePath);
    const keep = unjudged && existing !== null && existing.narHash === info.narHash;
    const ca = keep ? existing.ca : computed;
    const caProof = keep
      ? existing.caProof
      : unjudged
        ? "unknown"
        : ca === null
          ? "not-content-addressed"
          : "content-addressed";
    repo.putObject({
      bucket: bucket.name,
      storePath: info.storePath,
      hash: storePathHash(info.storePath),
      narHash: info.narHash,
      narSize: info.narSize,
      references: info.references,
      deriver: info.deriver,
      ca,
      caProof,
      compression: info.compression ?? "none",
      fileHash: file.fileHash,
      fileSize: file.fileSize,
      sigs,
      hits: existing?.hits ?? 0,
      created: existing?.created ?? at,
      lastWanted: at,
      run: provenance.run,
      commit: provenance.commit,
    });
    const recorded = repo.object(bucket.name, info.storePath);
    if (recorded !== null) await keepNarinfoObject(bucket, recorded);
    return true;
  }

  const staging = createStaging({
    storeOf,
    bucketNow: (name) => repo.bucket(name),
    dir,
    now,
    withWriteLock,
    record: recordNow,
    log: options.log,
    async keptFacts(bucket, narHash, compression) {
      const key = objectKey(bucket.name, narHash, compression);
      const objects = storeOf(bucket);
      const size = await objects.head(key);
      if (size === null) return null;
      const row = repo.objectByNarHashCompression(bucket.name, narHash, compression ?? "none");
      if (row !== null && row.fileHash !== null && row.fileSize === size) {
        return { fileHash: row.fileHash, fileSize: size };
      }
      const stored = await objects.facts(key);
      return stored === null ? null : keptFileOf(stored);
    },
  });
  const migrationSlots = createSlots(2);
  const backfillSlots = createSlots(2);
  const storeMoves = new Map<string, Promise<void>>();
  const moveSlots = createSlots(2);

  const startMigration = (row: MigrationRow): Promise<void> => {
    const running = storeMoves.get(row.bucket);
    if (running !== undefined) return running;
    const task = runMigration(row, {
      repo,
      storeNamed: (name) => stores.get(name) as ObjectStore,
      withWriteLock,
      slots: moveSlots,
      now,
      notify,
      ...(options.log === undefined ? {} : { log: options.log }),
      ...(options.purged === undefined ? {} : { purged: options.purged }),
      stopping: () => stopping,
    }).finally(() => {
      storeMoves.delete(row.bucket);
    });
    storeMoves.set(row.bucket, task);
    return task;
  };
  const unavailableLogged = new Set<string>();
  let migrationTask: Promise<MigrationReport> | null = null;
  let selfTask: Promise<SelfProofReport> | null = null;
  let backfillTask: Promise<ObjectBackfillReport> | null = null;
  let stopping = false;
  const stopSignal = Promise.withResolvers<void>();

  const listeners = new Set<() => void>();
  let lastReadNotify = Number.NEGATIVE_INFINITY;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const notifyReaders = (): void => {
    const at = now();
    if (at - lastReadNotify >= HITS_REFRESH_MS) {
      lastReadNotify = at;
      notify();
      return;
    }
    if (trailing !== null) return;
    trailing = setTimeout(() => {
      trailing = null;
      lastReadNotify = now();
      notify();
    }, HITS_REFRESH_MS);
  };

  const admin: CacheAdmin = {
    mount: CACHE_MOUNT,
    async create(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      if (!BUCKET_NAME.test(input.name)) {
        return {
          ok: false,
          code: "bad_input",
          message:
            input.name === ""
              ? "a bucket needs a name — lowercase letters, digits and dashes, e.g. my-project"
              : `"${input.name}" is not a bucket name — lowercase letters, digits and dashes`,
        };
      }
      const days = checkedDays(input.retentionDays);
      if (!days.ok) return days;
      if (repo.bucket(input.name) !== null) {
        return { ok: false, code: "bucket_exists", message: `bucket "${input.name}" already exists` };
      }
      const store = input.store ?? LOCAL_STORE;
      if (!stores.has(store)) {
        return {
          ok: false,
          code: "unknown_store",
          message: `no store "${store}" — this daemon declares ${[...stores.keys()].join(", ")}`,
        };
      }
      const exposed = exposure(input.public, store);
      if (exposed !== null) return exposed;
      const keypair = generateKeypair(`${input.name}-1`);
      const bucket: BucketRow = {
        name: input.name,
        isPublic: input.public,
        retentionDays: input.retentionDays,
        keyName: keypair.name,
        secretKey: keypair.secretKey,
        publicKey: keypair.publicKey,
        upstreamKeys: input.upstreamKeys,
        created: now(),
        domain: null,
        store,
      };
      repo.putBucket(bucket);
      await keepCacheInfoObject(bucket);
      notify();
      return { ok: true, value: factsOf(bucket) };
    },

    async list(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const counted = repo.bucketStats();
      return { ok: true, value: repo.buckets().map((bucket) => factsOf(bucket, counted)) };
    },

    async describe(input) {
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      return {
        ok: true,
        value: {
          name: bucket.name,
          public: bucket.isPublic,
          publicKey: bucket.publicKey,
          domain: bucket.domain,
          store: bucket.store,
        },
      };
    },

    async domain(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      const domain = input.domain === null ? null : input.domain.trim().toLowerCase();
      if (domain !== null && !DOMAIN.test(domain)) {
        return {
          ok: false,
          code: "bad_input",
          message:
            `"${input.domain}" is not a domain name — a lowercase DNS name ` +
            "like cache.example.org, with no scheme and no port",
        };
      }
      if (domain !== null) {
        const holder = repo.bucketByDomain(domain);
        if (holder !== null && holder.name !== bucket.name) {
          return {
            ok: false,
            code: "bad_input",
            message: `"${domain}" already names the bucket "${holder.name}"`,
          };
        }
      }
      const next: BucketRow = { ...bucket, domain };
      repo.putBucket(next);
      notify();
      return { ok: true, value: factsOf(next) };
    },

    async tokenMint(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      if (input.expiresDays !== null && (!Number.isSafeInteger(input.expiresDays) || input.expiresDays <= 0)) {
        return {
          ok: false,
          code: "bad_input",
          message: "an expiry must be a whole number of days, one or more",
        };
      }
      const glob = input.bucketGlob ?? bucket.name;
      if (!/^[a-z0-9*-]+(,[a-z0-9*-]+)*$/.test(glob)) {
        return {
          ok: false,
          code: "bad_input",
          message: `"${glob}" is not a bucket glob — names, dashes and \`*\`, comma-separated`,
        };
      }
      const token = mintToken();
      const row: TokenRow = {
        id: mintTokenId(),
        hash: hashToken(token),
        bucketGlob: glob,
        scope: input.scope,
        expires: input.expiresDays === null ? null : now() + input.expiresDays * 24 * 60 * 60 * 1000,
        label: null,
        lastUsed: null,
        revoked: false,
        created: now(),
      };
      repo.putToken(row);
      return { ok: true, value: { token, facts: tokenFacts(row) } };
    },

    async tokenList(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const rows = repo.tokens();
      return {
        ok: true,
        value: rows
          .filter((row) => input.bucket === null || globMatches(row.bucketGlob, input.bucket))
          .map(tokenFacts),
      };
    },

    async tokenRevoke(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const revoked = repo.setTokenRevoked(input.id, true);
      if (!revoked) {
        return { ok: false, code: "bad_input", message: `no token "${input.id}"` };
      }
      return { ok: true, value: { id: input.id, revoked: true } };
    },

    async retention(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      const days = checkedDays(input.retentionDays);
      if (!days.ok) return days;
      const next: BucketRow = { ...bucket, retentionDays: input.retentionDays };
      repo.putBucket(next);
      notify();
      return { ok: true, value: factsOf(next) };
    },

    async migrateStore(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      if (!stores.has(input.store)) {
        return {
          ok: false,
          code: "unknown_store",
          message: `no store "${input.store}" — this daemon declares ${[...stores.keys()].join(", ")}`,
        };
      }
      const started = await withWriteLock(
        async (): Promise<CacheOutcome<MigrationRow>> => {
          const bucket = repo.bucket(input.bucket);
          if (bucket === null) {
            return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
          }
          if (input.store === bucket.store) {
            return {
              ok: false,
              code: "bad_input",
              message: `"${bucket.name}" already keeps its objects in "${input.store}"`,
            };
          }
          const exposed = exposure(bucket.isPublic, input.store);
          if (exposed !== null) return exposed;
          const running = repo.migration(bucket.name);
          if (running !== null) {
            return {
              ok: false,
              code: "bad_input",
              message:
                `"${bucket.name}" is already moving to "${running.toStore}" ` +
                `(${running.copied} of ${running.total} objects copied)`,
            };
          }
          const row: MigrationRow = {
            bucket: bucket.name,
            fromStore: bucket.store,
            toStore: input.store,
            state: "copying",
            copied: 0,
            total: migrationKeys(repo, bucket.name).length,
            bytes: 0,
            started: now(),
          };
          repo.putMigration(row);
          options.log?.("cache.bucket.migrate.start", {
            bucket: row.bucket,
            from: row.fromStore,
            to: row.toStore,
            total: row.total,
          });
          notify();
          return { ok: true, value: row };
        },
      );
      if (!started.ok) return started;
      startMigration(started.value);
      return { ok: true, value: factsOf(repo.bucket(started.value.bucket) as BucketRow) };
    },

    async bucketDelete(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      return withWriteLock(async (): Promise<CacheOutcome<BucketDeleted>> => {
        const bucket = repo.bucket(input.bucket);
        if (bucket === null) {
          return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
        }
        if (bucket.domain !== null) {
          return {
            ok: false,
            code: "bad_input",
            message:
              `"${bucket.name}" answers to "${bucket.domain}" — clear its domain ` +
              "before deleting it, so no DNS record is left pointing at nothing",
          };
        }
        const moving = repo.migration(bucket.name);
        if (moving !== null) {
          return {
            ok: false,
            code: "bad_input",
            message:
              `"${bucket.name}" is moving to "${moving.toStore}" ` +
              `(${moving.copied} of ${moving.total} objects copied) — wait for the move`,
          };
        }
        const store = storeOf(bucket);
        const removals: GcRemoval[] = repo.objects(bucket.name).map((row) => ({
          storePath: row.storePath,
          hash: row.hash,
          narFile: narFileName(row.narHash, row.compression),
        }));
        const held = new Map((await store.list(bucket.name)).map((one) => [one.key, one.size]));
        const unlisted = migrationKeys(repo, bucket.name)
          .map((entry) => entry.key)
          .filter((key) => !held.has(key));
        let objects = 0;
        let bytes = 0;
        await purgeKeys({
          objects: store,
          keys: [...held.keys(), ...unlisted],
          slots: moveSlots,
          removed: (key) => {
            const size = held.get(key);
            if (size === undefined) return;
            objects += 1;
            bytes += size;
          },
          failed: (_key, reason) => {
            throw reason;
          },
        });
        objects += await store.sweepTemp(bucket.name, now());
        options.purged?.({
          bucket: bucket.name,
          store: bucket.store,
          reason: "delete",
          removals,
          cacheInfo: true,
        });
        repo.deleteBucket(bucket.name);
        holdsMemo.delete(bucket.name);
        options.log?.("cache.bucket.deleted", { bucket: bucket.name, objects, bytes });
        notify();
        return { ok: true as const, value: { name: bucket.name, objects, bytes } };
      });
    },

    async pin(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      return pinChecked(bucket, input, "admin");
    },

    async pinList(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      return { ok: true, value: repo.pins(bucket.name) };
    },

    async pinDelete(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      return withWriteLock(async () => {
        if (!repo.deletePin(bucket.name, input.name)) {
          return {
            ok: false as const,
            code: "bad_input" as const,
            message: `no pin "${input.name}" in ${bucket.name}`,
          };
        }
        notify();
        return { ok: true as const, value: { bucket: bucket.name, name: input.name } };
      });
    },

    async gc(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const chosen = bucketsFor(input.bucket);
      if (!chosen.ok) return chosen;
      return { ok: true, value: await collectNow(chosen.value, input.bucket === null) };
    },

    async gcPlan(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const { retentionDays } = input;
      const days = checkedDays(retentionDays);
      if (!days.ok) return days;
      const chosen = bucketsFor(input.bucket);
      if (!chosen.ok) return chosen;
      const asked =
        retentionDays === null
          ? chosen.value
          : chosen.value.map((bucket) => ({ ...bucket, retentionDays }));
      return withWriteLock(async () => ({
        ok: true as const,
        value: previewGc(planFor(asked), GC_PREVIEW_PATHS),
      }));
    },

    async paths(input) {
      const bucket = repo.bucket(input.bucket);
      if (bucket === null) {
        return { ok: false, code: "unknown_bucket", message: `no bucket "${input.bucket}"` };
      }
      if (input.group === "name" && input.name !== undefined && input.name !== null) {
        return {
          ok: false,
          code: "bad_input",
          message:
            "group and name are exclusive: ask for the packages, or for one package's versions",
        };
      }
      const page = {
        limit: PATH_PAGE_SIZE,
        after: input.after,
        filter: input.filter,
        sort: input.sort ?? "pushed",
        descending: input.descending ?? true,
      };
      const { holds, byName } = holdsFor(bucket);
      const at = now();
      if (input.group === "name") {
        const grouped = repo.objectGroupsPage(bucket.name, page);
        const filter = page.filter === null || page.filter === "" ? null : page.filter;
        const versionsOf = (name: string): Hold[] =>
          (byName.get(name) ?? []).flatMap((path) => {
            const hold = holds.get(path);
            return hold === undefined || (filter !== null && !path.includes(filter)) ? [] : [hold];
          });
        return {
          ok: true,
          value: {
            paths: [],
            groups: grouped.rows.map((group) => ({
              ...group,
              keptBy: keptBy(longestHeld(versionsOf(group.name)) as Hold, at),
            })),
            next: grouped.next,
          },
        };
      }
      const listed = repo.objectsPage(bucket.name, { ...page, name: input.name ?? null });
      return {
        ok: true,
        value: {
          paths: listed.rows.map((row) => ({
            storePath: row.storePath,
            narSize: row.narSize,
            created: row.created,
            hits: row.hits,
            lastWanted: row.lastWanted,
            run: row.run,
            commit: row.commit,
            keptBy: keptBy(holds.get(row.storePath) as Hold, at),
          })),
          groups: null,
          next: listed.next,
        },
      };
    },

    async stats(input) {
      const root = requireRoot(input);
      if (!root.ok) return root;
      const counted = repo.bucketStats();
      return {
        ok: true,
        value: {
          buckets: repo.buckets().map((bucket) => factsOf(bucket, counted)),
          ...repo.objectTotals(),
        },
      };
    },
  };

  async function pinChecked(
    bucket: BucketRow,
    input: { name: string; paths: readonly string[] },
    by: PinAuthor,
  ): Promise<CacheOutcome<PinFacts>> {
    const name = input.name.trim();
    if (name === "") {
      return { ok: false, code: "bad_input", message: "a pin needs a name, e.g. release-1.2" };
    }
    if (input.paths.length === 0) {
      return { ok: false, code: "bad_input", message: "a pin needs at least one path" };
    }
    return withWriteLock(async () => {
      const held = repo.pins(bucket.name).find((pin) => pin.name === name);
      if (by === "write" && held !== undefined && held.createdBy === "admin") {
        return {
          ok: false as const,
          code: "not_permitted" as const,
          message:
            `the pin "${held.name}" was made by an administrator — a write token may ` +
            "re-point only a pin a write token made, because re-pointing releases " +
            "whatever the pin held before",
        };
      }
      return pinNow(bucket, { name, paths: input.paths }, by);
    });
  }

  async function pinNow(
    bucket: BucketRow,
    input: { name: string; paths: readonly string[] },
    by: PinAuthor,
  ): Promise<CacheOutcome<PinFacts>> {
    const rows = new Map(repo.objects(bucket.name).map((row) => [row.storePath, row]));
    const absent = input.paths.filter((path) => !rows.has(path));
    if (absent.length > 0) {
      return {
        ok: false,
        code: "bad_input",
        message: `no such path in the bucket: ${absent.join(", ")}`,
      };
    }
    const reached = [...closureOf(input.paths, rows)].filter((path) => rows.has(path));
    const created = now();
    repo.putPin({
      bucket: bucket.name,
      name: input.name,
      rootPaths: reached,
      created,
      createdBy: by,
    });
    notify();
    return {
      ok: true,
      value: {
        bucket: bucket.name,
        name: input.name,
        rootPaths: reached,
        created,
        createdBy: by,
      },
    };
  }

  function bucketsFor(name: string | null): CacheOutcome<readonly BucketRow[]> {
    if (name === null) return { ok: true, value: repo.buckets() };
    const bucket = repo.bucket(name);
    if (bucket === null) {
      return { ok: false, code: "unknown_bucket", message: `no bucket "${name}"` };
    }
    return { ok: true, value: [bucket] };
  }

  const planFor = (buckets: readonly BucketRow[]): GcBucketPlan[] =>
    planGc({ buckets, objects: repo.objects(), pins: repo.pins(), now: now() });

  async function collectNow(
    buckets: readonly BucketRow[],
    sweep: boolean,
  ): Promise<GcCollection> {
    const plan = await withWriteLock(async () => planFor(buckets));
    const collected = await runGc(repo, plan, objectsOf, { now, withLock: withWriteLock });
    const { report } = collected;
    if (sweep && report.stopped === null) {
      for (const bucket of buckets) {
        const swept = await sweepOrphans(repo, bucket.name, storeOf(bucket));
        const entry = report.buckets.find((one) => one.bucket === bucket.name);
        if (entry !== undefined) entry.orphans = swept;
        report.orphans += swept;
      }
    }
    if (report.evicted > 0 || report.orphans > 0) notify();
    options.log?.("cache.gc", {
      evicted: report.evicted,
      kept: report.kept,
      orphans: report.orphans,
      bytes: report.bytes,
      buckets: report.buckets.map((one) => ({
        bucket: one.bucket,
        evicted: one.evicted,
        bytes: one.bytes,
      })),
      ...(report.stopped === null ? {} : { stopped: report.stopped }),
    });
    return collected;
  }

  async function proveSelfNow(): Promise<SelfProofReport> {
    const rows = repo.objects().filter(
      (row) => row.caProof === "unknown" && row.references.includes(row.storePath),
    );
    if (rows.length === 0) {
      return { rows: 0, proved: 0, refused: 0, unreadable: 0, skipped: 0 };
    }
    options.log?.("cache.self_ca.start", {
      rows: rows.length,
      bytes: rows.reduce((sum, row) => sum + (row.fileSize ?? row.narSize), 0),
    });
    let next = 0;
    let proved = 0;
    let refused = 0;
    let unreadable = 0;
    let done = 0;
    let skipped = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (stopping) return;
        const row = rows[next++];
        if (row === undefined) return;
        const object = await objectsOf(row.bucket)
          .get(objectKey(row.bucket, row.narHash, row.compression))
          .catch(() => null);
        if (object === null) {
          unreadable += 1;
          continue;
        }
        const checked = await Promise.race([
          verifyNarStream(object, row.compression, storePathHash(row.storePath)),
          stopSignal.promise.then(() => {
            void object.stream.cancel().catch(() => {});
            return null;
          }),
        ]);
        if (checked === null || stopping) return;
        done += 1;
        if (!checked.ok || checked.selfHash === null) {
          unreadable += 1;
        } else {
          const selfHash = checked.selfHash;
          const outcome = await withWriteLock(async () => {
            const bucket = repo.bucket(row.bucket);
            const current = bucket === null ? null : repo.object(bucket.name, row.storePath);
            if (
              bucket === null ||
              current === null ||
              current.narHash !== row.narHash ||
              current.caProof !== "unknown"
            ) {
              return "skipped" as const;
            }
            const ca = contentAddressOf({
              storePath: current.storePath,
              narHash: current.narHash,
              references: current.references,
              selfHash,
            });
            const judged: ObjectRow = {
              ...current,
              ca,
              caProof: ca === null ? "not-content-addressed" : "content-addressed",
            };
            repo.putObject(judged);
            if (ca === null) return "refused" as const;
            await keepNarinfoObject(bucket, judged);
            return "proved" as const;
          });
          if (outcome === "skipped") skipped += 1;
          else if (outcome === "refused") refused += 1;
          else proved += 1;
        }
        if (done % 100 === 0) {
          options.log?.("cache.self_ca.progress", { done, of: rows.length });
        }
      }
    };
    await Promise.all([worker(), worker()]);
    if (proved > 0) notify();
    options.log?.("cache.self_ca.complete", {
      rows: rows.length,
      proved,
      refused,
      unreadable,
      skipped,
    });
    return { rows: rows.length, proved, refused, unreadable, skipped };
  }

  async function migrateNow(): Promise<MigrationReport> {
      const missing = repo.objects().filter((row) => row.fileHash === null);
      if (missing.length === 0) {
        return { migrated: 0, failures: 0, complete: true, paused: null };
      }
      const legacy = options.legacyStore;
      if (legacy === undefined || legacy === null) {
        options.log?.("cache.migration.incomplete", {
          remaining: missing.length,
          reason: "no old store is configured",
        });
        return { migrated: 0, failures: missing.length, complete: false, paused: null };
      }
      const floor = options.migrationFreeFloor ?? 10 * 1024 * 1024 * 1024;
      const retryMs = options.migrationRetryMs ?? 60_000;
      const free = options.freeBytes ?? (async () => {
        const stats = await statfs(join(dir, "objects")).catch(() => null);
        return stats === null ? null : stats.bavail * stats.bsize;
      });
      const available = await free().catch(() => null);
      options.log?.("cache.migration.start", {
        objects: missing.length,
        narBytes: missing.reduce((sum, row) => sum + row.narSize, 0),
        freeBytes: available,
      });

      let next = 0;
      let migrated = 0;
      let failures = 0;
      let paused: string | null = null;
      const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));

      const migrateOne = async (row: (typeof missing)[number]): Promise<void> => {
        for (;;) {
          if (stopping) return;
          const bytes = await free().catch(() => null);
          if (bytes === null || bytes >= floor) break;
          if (paused === null) {
            paused = `free space ${Math.round(bytes / 1024 ** 2)} MiB is below the ${Math.round(
              floor / 1024 ** 2,
            )} MiB floor`;
            options.log?.("cache.migration.pause", { reason: paused, at: row.storePath });
          }
          await Promise.race([sleep(retryMs), stopSignal.promise]);
        }
        if (stopping) return;
        if (paused !== null) {
          options.log?.("cache.migration.resume", { at: row.storePath });
          paused = null;
        }
        try {
          if (stopping) return;
          const known =
            legacy.pathInfo === undefined
              ? undefined
              : await legacy.pathInfo(row.storePath).catch(() => null);
          if (known === null) {
            failures += 1;
            options.log?.("cache.migration.object_failed", {
              bucket: row.bucket,
              path: row.storePath,
              reason: "the old store does not have this path",
            });
            return;
          }
          if (
            known !== undefined &&
            canonicalNarHash(known.narHash) !== row.narHash
          ) {
            failures += 1;
            options.log?.("cache.migration.object_failed", {
              bucket: row.bucket,
              path: row.storePath,
              reason: `the old store has ${known.narHash} but the row is ${row.narHash}`,
            });
            return;
          }
          const key = objectKey(row.bucket, row.narHash, row.compression);
          const objects = objectsOf(row.bucket);
          const stored = await objects.facts(key);
          if (stored !== null) {
            repo.putObject({ ...row, ...keptFileOf(stored) });
            migrated += 1;
            return;
          }
          const dump = legacy.dump(row.storePath);
          const writing = migrationSlots.withSlot(async (): Promise<ObjectFacts> => {
            const outcome = await objects.put(key, dump, undefined, {
              contentType: NAR_CONTENT_TYPE,
              cacheControl: NAR_CACHE_CONTROL,
            });
            if (outcome.ok) return outcome.facts;
            if (outcome.refusal.kind === "exists") return outcome.refusal.facts;
            throw new Error(`${key}: the store kept nothing (${outcome.refusal.kind})`);
          });
          void writing.catch(() => {});
          const facts = await Promise.race([
            writing,
            stopSignal.promise.then(() => {
              void dump.cancel().catch(() => {});
              return null;
            }),
          ]);
          if (facts === null || stopping) return;
          repo.putObject({ ...row, ...keptFileOf(facts) });
          migrated += 1;
          if (migrated % 100 === 0) {
            options.log?.("cache.migration.progress", {
              migrated,
              remaining: repo.objects().filter((one) => one.fileHash === null).length,
            });
          }
        } catch (err) {
          failures += 1;
          options.log?.("cache.migration.object_failed", {
            bucket: row.bucket,
            path: row.storePath,
            reason: String((err as Error).message ?? err),
          });
        }
      };

      const workers = Array.from({ length: Math.min(2, missing.length) }, async () => {
        for (;;) {
          if (stopping) return;
          const row = missing[next++];
          if (row === undefined) return;
          await migrateOne(row);
        }
      });
      await Promise.all(workers);

      const complete = repo.objects().every((row) => row.fileHash !== null);
      const remaining = repo.objects().filter((row) => row.fileHash === null).length;
      if (complete && migrated > 0) {
        options.log?.("cache.migration.complete", {
          migrated,
          note: "the old store is no longer read and can be deleted",
        });
      } else if (!complete) {
        options.log?.("cache.migration.incomplete", { migrated, failed: failures, remaining });
      }
    return { migrated, failures, complete, paused };
  }

  async function backfillNow(): Promise<ObjectBackfillReport> {
    const buckets = repo.buckets();
    let rows = 0;
    let written = 0;
    let failures = 0;
    for (const snapshot of buckets) {
      if (stopping) break;
      const existing = await withWriteLock(async () => {
        const bucket = repo.bucket(snapshot.name);
        if (bucket !== null) await keepCacheInfoObject(bucket);
        return bucket;
      });
      if (existing === null) continue;
      const bucket = existing;
      const all = repo.objects(bucket.name);
      rows += all.length;
      let done = 0;
      let inBucket = 0;
      const one = async (row: ObjectRow): Promise<void> => {
        if (stopping) return;
        const at = repo.bucket(bucket.name);
        if (at === null) return;
        const key = narinfoKey(at.name, row.hash);
        const text = narinfoFor(at, row);
        const size = await storeOf(at).head(key).catch(() => null);
        if (row.fileHash !== null && size !== new TextEncoder().encode(text).length) {
          const outcome = await withWriteLock(async () => {
            const now = repo.bucket(bucket.name);
            if (now === null || repo.object(now.name, row.storePath) === null) {
              return "same" as const;
            }
            return keepNarinfoObject(now, row);
          });
          if (outcome === "failed") failures += 1;
          else if (outcome !== "same") {
            written += 1;
            inBucket += 1;
          }
        }
        done += 1;
        if (done % 500 === 0) {
          options.log?.("cache.narinfo.backfill", {
            bucket: bucket.name,
            written: inBucket,
            remaining: all.length - done,
          });
        }
      };
      await Promise.all(
        all.map((row) =>
          backfillSlots.withSlot(() => one(row)).catch(() => {
            failures += 1;
          }),
        ),
      );
      options.log?.("cache.narinfo.backfill", {
        bucket: bucket.name,
        written: inBucket,
        remaining: all.length - done,
      });
    }
    return { rows, written, failures };
  }

  return {
    bucket: (name) => repo.bucket(name),

    bucketByDomain: (host) => repo.bucketByDomain(host),

    authorize(header, bucket, need) {
      const presented = credentialOf(header);
      if (presented === null) {
        if (need === "read" && bucket.isPublic) return { ok: true };
        return {
          ok: false,
          status: bucket.isPublic ? 401 : 404,
          message: bucket.isPublic ? "this bucket needs a token" : "no such bucket",
        };
      }
      if (rootTokenMatches(options.rootToken, presented)) return { ok: true };
      const verdict = verifyToken(repo, presented, bucket.name, need, now());
      if (verdict.ok) return { ok: true };
      const message =
        verdict.reason === "expired"
          ? `that token expired on ${new Date(verdict.expiredAt).toISOString().slice(0, 10)}`
          : {
              unknown: "that token is not one this service minted",
              revoked: "that token has been revoked",
              wrong_bucket: `that token cannot reach "${bucket.name}"`,
              insufficient: `that token cannot ${need === "read" ? "read" : "write"} here`,
            }[verdict.reason];
      return { ok: false, status: 403, message };
    },

    narinfoText(bucket, hash) {
      if (!isStorePathHash(hash)) return null;
      const row = repo.objectByHash(bucket.name, hash);
      return row === null ? null : narinfoFor(bucket, row);
    },

    cacheInfoText,

    log: (event, fields) => options.log?.(event, fields),

    touch(bucket, hash) {
      if (!isStorePathHash(hash)) return;
      const row = repo.objectByHash(bucket.name, hash);
      if (row === null) return;
      repo.countRead(bucket.name, row.storePath);
      notifyReaders();
    },

    async narSource(bucket, file) {
      const at = file.indexOf(".nar");
      const hash = at === -1 ? file : file.slice(0, at);
      const narHash = `sha256:${hash}`;
      const compression = compressionOfFile(file);
      if (compression === null) return null;
      const row =
        repo.objectByNarHashCompression(bucket.name, narHash, compression) ??
        (() => {
          const twins = repo.objectsByNarHash(bucket.name, narHash);
          return twins.length === 1 ? (twins[0] as ObjectRow) : null;
        })();
      if (row === null) return null;
      if (row.fileHash !== null && row.fileSize !== null) {
        const key = objectKey(bucket.name, narHash, row.compression);
        const objects = storeOf(bucket);
        if (objects.presignGet !== undefined) {
          return {
            kind: "redirect",
            storePath: row.storePath,
            size: row.fileSize,
            url: objects.presignGet(key, PRESIGN_SECONDS),
          };
        }
        return {
          kind: "object",
          storePath: row.storePath,
          size: row.fileSize,
          read: async (range) => (await objects.get(key, range))?.stream ?? null,
        };
      }
      const legacy = options.legacyStore;
      if (legacy === undefined || legacy === null) return null;
      if (legacy.pathInfo !== undefined) {
        const known = await legacy.pathInfo(row.storePath).catch(() => null);
        if (known === null) {
          if (!unavailableLogged.has(row.storePath)) {
            unavailableLogged.add(row.storePath);
            options.log?.("cache.nar.unavailable", {
              bucket: bucket.name,
              path: row.storePath,
              reason: "no object and the old store does not have the path",
            });
          }
          return null;
        }
      }
      return { kind: "legacy", storePath: row.storePath, stream: legacy.dump(row.storePath) };
    },

    beginUpload: (bucket, file) => staging.beginUpload(bucket, file),
    beginDirect: (bucket, file, floor) => staging.beginDirect(bucket, file, floor),
    directPart: (bucket, file, upload, index) =>
      staging.directPart(bucket, file, upload, index),
    completeDirect: (bucket, file, upload, parts) =>
      staging.completeDirect(bucket, file, upload, parts),
    beginPart: (bucket, file, index, limit, session) =>
      staging.beginPart(bucket, file, index, limit, session),
    completeUpload: (bucket, file, total, session) =>
      staging.completeUpload(bucket, file, total, session),
    async acceptNarinfo(bucket, hash, body, provenance) {
      const outcome = await staging.acceptNarinfo(bucket, hash, body, provenance);
      notify();
      return outcome;
    },

    missing(bucket, paths, provenance, whole) {
      const missing: string[] = [];
      const skipped: string[] = [];
      const wanted: string[] = [];
      for (const { path, sigs } of paths) {
        if (repo.object(bucket.name, path) !== null) {
          wanted.push(path);
          continue;
        }
        const upstream =
          !whole &&
          (sigs ?? []).some((sig) => {
            const key = keyNameOf(sig);
            return key !== null && bucket.upstreamKeys.includes(key);
          });
        (upstream ? skipped : missing).push(path);
      }
      repo.want(bucket.name, wanted, now(), provenance);
      return { missing, skipped };
    },

    collect: () => collectNow(repo.buckets(), true),

    pinAs: (bucket, input) => pinChecked(bucket, input, "write"),

    grantRunToken: ({ bucket, runId }) => {
      const row = repo.bucket(bucket);
      if (row === null) return null;
      const token = mintToken();
      const id = mintTokenId();
      repo.putToken({
        id,
        hash: hashToken(token),
        bucketGlob: row.name,
        scope: "write",
        expires: now() + RUN_TOKEN_LIFETIME_MS,
        label: `run ${runId}`,
        lastUsed: null,
        revoked: false,
        created: now(),
      });
      return { id, token };
    },

    revokeToken: (id) => {
      repo.setTokenRevoked(id, true);
    },

    admin,

    snapshot: () => {
      const counted = repo.bucketStats();
      return repo.buckets().map((bucket) => factsOf(bucket, counted));
    },

    meterGauges: () => {
      const counted = repo.bucketStats();
      const pinned = repo.pinCounts();
      return repo.buckets().map((bucket) => {
        const counts = counted.get(bucket.name);
        return {
          bucket: bucket.name,
          objects: counts?.objects ?? 0,
          bytes: counts?.bytes ?? 0,
          hits: counts?.hits ?? 0,
          pins: pinned.get(bucket.name) ?? 0,
        };
      });
    },

    async boot() {
      for (const bucket of repo.buckets()) {
        if (!stores.has(bucket.store)) {
          return {
            ok: false as const,
            refusal: {
              kind: "undeclared_store" as const,
              bucket: bucket.name,
              store: bucket.store,
              declared: [...stores.keys()],
            },
          };
        }
      }

      let caProved = 0;
      for (const row of repo.objects().filter(
        (one) => one.caProof === "unknown" && !one.references.includes(one.storePath),
      )) {
        const ca = contentAddressOf({
          storePath: row.storePath,
          narHash: row.narHash,
          references: row.references,
        });
        repo.putObject({
          ...row,
          ca,
          caProof: ca === null ? "not-content-addressed" : "content-addressed",
        });
        if (ca !== null) caProved += 1;
      }
      if (caProved > 0) {
        options.log?.("cache.boot.ca", { proved: caProved });
        notify();
      }

      const owned = new Set([
        ...repo.objects().flatMap((row) => [
          objectKey(row.bucket, row.narHash, row.compression),
          narinfoKey(row.bucket, row.hash),
        ]),
        ...repo.buckets().map((bucket) => cacheInfoKey(bucket.name)),
      ]);
      let tempSwept = 0;
      let orphansSwept = 0;
      for (const bucket of repo.buckets()) {
        const objects = storeOf(bucket);
        tempSwept += await objects.sweepTemp(bucket.name, now());
        for (const object of await objects.list(bucket.name)) {
          if (owned.has(object.key)) continue;
          await objects.delete(object.key);
          orphansSwept += 1;
        }
      }
      if (orphansSwept > 0 || tempSwept > 0) {
        options.log?.("cache.boot.orphans", { swept: orphansSwept, temp: tempSwept });
      }
      return { ok: true as const, report: { caProved, orphansSwept, tempSwept } };
    },

    proveSelf() {
      const task = proveSelfNow();
      selfTask = task;
      return task;
    },

    migrate() {
      const task = migrateNow();
      migrationTask = task;
      return task;
    },

    backfillObjects() {
      const task = backfillNow();
      backfillTask = task;
      return task;
    },

    async resumeMigrations() {
      await Promise.all(repo.migrations().map((row) => startMigration(row)));
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async close() {
      if (trailing !== null) clearTimeout(trailing);
      trailing = null;
      stopping = true;
      stopSignal.resolve();
      if (migrationTask !== null) await migrationTask.catch(() => {});
      if (selfTask !== null) await selfTask.catch(() => {});
      if (backfillTask !== null) await backfillTask.catch(() => {});
      await Promise.all([...storeMoves.values()].map((task) => task.catch(() => {})));
      migrationSlots.close();
      backfillSlots.close();
      moveSlots.close();
      await staging.close();
      listeners.clear();
      repo.close();
    },
  };
}

/**
 * The credential out of an `Authorization` header: `Bearer <token>`, or Basic
 * with any username and the token as the password.
 *
 * Basic is not a courtesy — it is the ONLY way Nix authenticates. `nix copy`
 * speaks it through curl on every request, uploads included, which is why a
 * cache that accepted only Bearer would be a cache no Nix client could write
 * to.
 */
/** Is this the whitespace a header can hold? Space and tab, and nothing else:
 *  a field value cannot contain CR or LF (RFC 9110 §5.5, and Node's parser
 *  rejects it before a route sees it), so the rest of `\s` is unreachable
 *  input and treating it as part of the scheme is the safe reading. */
const headerSpace = (ch: string): boolean => ch === " " || ch === "\t";

function credentialOf(header: string | undefined): string | null {
  if (header === undefined) return null;
  let at = 0;
  while (at < header.length && !headerSpace(header[at] as string)) at++;
  const scheme = header.slice(0, at).toLowerCase();
  if (at === header.length) return null;
  let payloadAt = at;
  while (payloadAt < header.length && headerSpace(header[payloadAt] as string)) payloadAt++;
  const payload = header.slice(payloadAt).trim();
  if (scheme === "bearer") return payload;
  if (scheme !== "basic") return null;
  let decoded: string;
  try {
    decoded = Buffer.from(payload, "base64").toString("utf8");
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  return colon === -1 ? null : decoded.slice(colon + 1);
}
