import { createControl, type Control } from "@odu/face/control";
import { ago, ahead, bytes } from "@odu/cordis/format";
import { refusalText } from "@odu/face/refusal";
import {
  BackLink,
  Button,
  CopyButton,
  type Copied,
  copyText,
  Choice,
  Field,
  KeyValue,
  PageHead,
  Panel,
  Pill,
  Disclosure,
  Fields,
  Receipt,
  SearchInput,
  Table,
  type TableColumn,
  Stat,
  Tag,
  TextInput,
  Toggle,
} from "@odu/face/ui";
import type { SurfaceClient } from "@kolu/surface/solid";
import type { Effect } from "effect";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
  Switch,
  Match,
  type JSX,
} from "solid-js";
import {
  type CacheBucket,
  type CacheGcPlan,
  type CacheMigration,
  type CacheKeptBy,
  type CachePath,
  type CachePaths,
  type CachePin,
  type CacheToken,
  FLAKE_CONFIG_NOTE,
  flakeBlock,
  MACHINE_CONFIG_NOTE,
  netrcBlock,
  nixConfBlock,
  nixOsBlock,
  oduCacheSurface,
  PATH_PAGE_SIZE,
  ACTION_REF_PLACEHOLDER,
  DEFAULT_RETENTION_DAYS,
  LOCAL_STORE,
  actionsPushBlock,
  type PathSort,
  pushBlock,
  storePathParts,
  useCommand,
  type CacheScope,
} from "./surface";

type CacheSpec = (typeof oduCacheSurface)["spec"];

export function readsFromText(bucket: Pick<CacheBucket, "readsFrom" | "url">): string {
  if (bucket.readsFrom !== "store") return "reads served by odu";
  try {
    return `reads served from ${new URL(bucket.url).host}`;
  } catch {
    return `reads served from ${bucket.url}`;
  }
}

export type CacheClient = SurfaceClient<CacheSpec>;

export interface CacheFaceProps {
  client: CacheClient;
  bucket: string | null;
  onOpen: (bucket: string | null) => void;
  pushActionRef: () => string | null;
  runHref: (runId: string) => string;
  now: number;
  canAdminister: boolean;
  tunnelRow: boolean;
  local: boolean;
  call: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
}

interface AdminProps {
  client: CacheClient;
  call: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  rootToken: () => string;
  armed: () => boolean;
}

interface TokenField {
  typedToken: () => string;
  onTypedToken: (value: string) => void;
}

export function CacheFace(props: CacheFaceProps): JSX.Element {
  const [rootToken, setRootToken] = createSignal("");
  const admin: AdminProps & TokenField = {
    get client() {
      return props.client;
    },
    get call() {
      return props.call;
    },
    rootToken: () => (props.local ? rootToken() : ""),
    armed: () => !props.local || rootToken() !== "",
    typedToken: rootToken,
    onTypedToken: setRootToken,
  };
  return (
    <Show
      when={props.bucket}
      fallback={
        <BucketList
          {...admin}
          now={props.now}
          onOpen={props.onOpen}
          canAdminister={props.canAdminister}
          local={props.local}
        />
      }
    >
      {(name) => (
        <BucketPage
          {...admin}
          name={name()}
          now={props.now}
          onOpen={props.onOpen}
          canAdminister={props.canAdminister}
          local={props.local}
          tunnelRow={props.tunnelRow}
          pushActionRef={props.pushActionRef}
          runHref={props.runHref}
        />
      )}
    </Show>
  );
}

function RootTokenField(props: TokenField): JSX.Element {
  return (
    <Field
      id="cache-root-token"
      label="root token"
    >
      <input
        id="cache-root-token"
        type="password"
        class="input"
        autocomplete="off"
        placeholder="$ODU_ROOT_TOKEN"
        value={props.typedToken()}
        onInput={(event) => props.onTypedToken(event.currentTarget.value)}
      />
    </Field>
  );
}

function DocsLink(): JSX.Element {
  return (
    <a class="link" href="https://odu.kolu.dev/docs/cache/" target="_blank" rel="noreferrer">
      docs
    </a>
  );
}

function CreateBucket(
  props: AdminProps &
    TokenField & { local: boolean; onCreated: (bucket: string | null) => void },
): JSX.Element {
  const [name, setName] = createSignal("");
  const [upstream, setUpstream] = createSignal(true);
  const stores = props.client.cells.stores.use();
  const offered = createMemo(() => stores.value() ?? []);
  const fallback = createMemo(() => offered().find((one) => one.default)?.name ?? "");
  const [store, setStore] = createSignal<string | null>(null);
  const chosen = createMemo(() => store() ?? fallback());
  const control = createControl(props.call);
  const create = (): void => {
    control.run(
      props.client.procedures.bucket.create({
        rootToken: props.rootToken(),
        name: name().trim(),
        public: true,
        ...(upstream() ? {} : { upstreamKeys: [] }),
        ...(store() === null ? {} : { store: store() as string }),
      }),
      (created) => {
        setName("");
        props.onCreated(created.name);
        return `Created ${created.name}.`;
      },
    );
  };
  const [open, setOpen] = createSignal(false);
  return (
    <Panel class="panel-dashed" label="new bucket">
      <div class="panel-body">
        <Disclosure summary="New bucket" open={open()} onToggle={() => setOpen((was) => !was)}>
          <Fields>
            <Field id="new-bucket-name" label="name">
              <TextInput
                id="new-bucket-name"
                value={name()}
                placeholder="new bucket name"
                onValue={setName}
              />
            </Field>
            <Show when={offered().length > 1}>
              <fieldset class="toggles">
                <legend>where its objects live</legend>
                <div class="form-pair">
                  <For each={offered()}>
                    {(one) => (
                      <Choice
                        name="bucket-store"
                        value={one.name}
                        checked={chosen() === one.name}
                        label={one.name}
                        note={
                          (one.kind === "local" ? "this server's disk" : "an S3 store") +
                          (one.default ? ", the default" : "")
                        }
                        onPick={(picked) => setStore(picked === fallback() ? null : picked)}
                      />
                    )}
                  </For>
                </div>
              </fieldset>
            </Show>
            <Toggle id="new-bucket-upstream" checked={upstream()} onChecked={setUpstream}>
              Skip upstream paths
            </Toggle>
            <Button class="btn-primary" disabled={control.busy()} onClick={create}>
              {control.busy() ? "creating…" : "Create bucket"}
            </Button>
          </Fields>
        </Disclosure>
        <Answer control={control} />
      </div>
    </Panel>
  );
}

function keepIdentity<T>(keyOf: (row: T) => string): (row: T) => T {
  const held = new Map<string, { readonly row: T; readonly encoded: string }>();
  return (row) => {
    const key = keyOf(row);
    const encoded = JSON.stringify(row);
    const seen = held.get(key);
    if (seen !== undefined && seen.encoded === encoded) return seen.row;
    held.set(key, { row, encoded });
    return row;
  };
}

export function emptyBucketsText(viewer: { canAdminister: boolean; local: boolean }): string {
  if (viewer.local) {
    return "No buckets yet — odu surface cache bucket_create makes one, or use the form below.";
  }
  if (viewer.canAdminister) return "No buckets yet — name one in the form below to create it.";
  return "There are no buckets yet.";
}

function BucketList(
  props: AdminProps &
    TokenField & {
      now: number;
      onOpen: (bucket: string | null) => void;
      canAdminister: boolean;
      local: boolean;
    },
): JSX.Element {
  const held = props.client.collections.buckets.use();
  const stable = keepIdentity<CacheBucket>((row) => row.name);
  const rows = createMemo<CacheBucket[]>(() => {
    const out: CacheBucket[] = [];
    for (const key of held.keys()) {
      const row = held.byKey(key)?.();
      if (row !== undefined) out.push(stable(row));
    }
    return out.sort((left, right) => left.name.localeCompare(right.name));
  });
  return (
    <section class="screen cache" aria-label="buckets">
      <PageHead
        title="Cache"
        actions={
          <Show when={props.local && props.canAdminister}>
            <div class="page-actions">
              <RootTokenField
                typedToken={props.typedToken}
                onTypedToken={props.onTypedToken}
              />
            </div>
          </Show>
        }
      />

      <Show
        when={rows().length > 0}
        fallback={
          <p class="empty">
            {emptyBucketsText({ canAdminister: props.canAdminister, local: props.local })}
          </p>
        }
      >
        {}
        <ul class="buckets cards" aria-label="Buckets">
          <For each={rows()}>
            {(bucket) => (
              <li>
                {}
                <button
                  type="button"
                  class="bucket card"
                  onClick={() => props.onOpen(bucket.name)}
                >
                  <span class="card-head">
                    <span class="field">
                      <span class="card-name">{bucket.name}</span>
                      <span class="card-url">{bucket.url}</span>
                    </span>
                    {}
                    <Tag>{bucket.store}</Tag>
                  </span>
                  <span class="stats-strip">
                    <Stat value={bucket.objects} label="paths" />
                    <Stat value={bytes(bucket.bytes)} label="stored" />
                    <Stat value={bucket.hits} label="reads" />
                  </span>
                  <span class="fact-line bucket-facts">
                    <span>
                      {bucket.lastPush === null
                        ? "nothing pushed"
                        : `pushed ${ago(bucket.lastPush, props.now)}`}
                    </span>
                    {}
                    <span>
                      {bucket.public ? "public" : "private"} ·{" "}
                      {bucket.retentionDays > 0 ? `${bucket.retentionDays}d` : "kept"}
                    </span>
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      {}
      <Show when={props.canAdminister}>
        <CreateBucket
          client={props.client}
          call={props.call}
          rootToken={props.rootToken}
          armed={props.armed}
          typedToken={props.typedToken}
          onTypedToken={props.onTypedToken}
          local={props.local}
          onCreated={props.onOpen}
        />
      </Show>
    </section>
  );
}

type FirstPage =
  | {
      readonly ok: true;
      readonly rows: readonly PathRow[];
      readonly next: string | null;
      readonly retentionDays: number;
    }
  | { readonly ok: false; readonly message: string };

type Versions =
  | { readonly kind: "reading" }
  | {
      readonly kind: "held";
      readonly versions: readonly CachePath[];
      readonly next: string | null;
      readonly reading: boolean;
    }
  | { readonly kind: "failed"; readonly message: string };

const FILTER_DEBOUNCE_MS = 200;

interface SetupDestination {
  readonly name: string;
  readonly blockClass: string;
  readonly text: (facts: SetupFacts) => string;
  readonly note?: string;
}

interface SetupFacts {
  readonly url: string;
  readonly publicKey: string;
  readonly public: boolean;
  readonly bucket: string;
  readonly token: string | null;
  readonly ref: string;
}

const SETUP_TABS: readonly [SetupDestination, ...SetupDestination[]] = [
  {
    name: "nix.conf",
    blockClass: "consume-block",
    text: (facts) =>
      facts.public
        ? nixConfBlock(facts)
        : `${nixConfBlock(facts)}\n\n${netrcBlock({ url: facts.url, home: null })}`,
    note: MACHINE_CONFIG_NOTE,
  },
  { name: "NixOS", blockClass: "consume-block", text: nixOsBlock, note: MACHINE_CONFIG_NOTE },
  { name: "flake.nix", blockClass: "consume-block", text: flakeBlock, note: FLAKE_CONFIG_NOTE },
  { name: "odu CLI", blockClass: "consume-block", text: (facts) => useCommand(facts.bucket) },
  {
    name: "push",
    blockClass: "push-block",
    text: (facts) => pushBlock({ url: facts.url, token: facts.token }),
  },
  {
    name: "GitHub Actions",
    blockClass: "actions-push-block",
    text: (facts) => actionsPushBlock({ url: facts.url, ref: facts.ref }),
  },
];

const BUCKET_TABS = ["Paths", "Pins"] as const;
type BucketTab = (typeof BUCKET_TABS)[number];

export const HASH_SHOWN = 8;

const SHA_SHOWN = 7;

export type PathColumn = PathSort;

export interface PathRow {
  readonly name: string;
  readonly storePath: string;
  readonly versions: number;
  readonly bytes: number;
  readonly hits: number;
  readonly pushed: number;
  readonly wanted: number;
  readonly run: string | null;
  readonly commit: string | null;
  readonly keptBy: CacheKeptBy | null;
}

const pathRow = (path: CachePath, name: string): PathRow => ({
  name,
  storePath: path.storePath,
  versions: 1,
  bytes: path.narSize,
  hits: path.hits,
  pushed: path.created,
  wanted: path.lastWanted,
  run: path.run ?? null,
  commit: path.commit ?? null,
  keptBy: path.keptBy ?? null,
});

export function pathRows(page: CachePaths): readonly PathRow[] {
  if (page.groups !== undefined) {
    return page.groups.map((group) => ({
      name: group.name,
      storePath: group.storePath,
      versions: group.versions,
      bytes: group.bytes,
      hits: group.hits,
      pushed: group.pushed,
      wanted: group.wanted,
      run: group.run ?? null,
      commit: group.commit ?? null,
      keptBy: group.keptBy ?? null,
    }));
  }
  return page.paths.map((path) => pathRow(path, storePathParts(path.storePath).name));
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function keptByText(
  keptBy: CacheKeptBy,
  now: number,
  options: { grouped: boolean; retentionDays: number },
): { cell: string; title: string } {
  const leaves = `leaves at the first collection after ${new Date(keptBy.until).toISOString().slice(0, 10)}`;
  const wanted = ago(keptBy.until - options.retentionDays * DAY_MS, now);
  const said = (cell: string, title: string): { cell: string; title: string } => ({
    cell,
    title: options.grouped ? `${title} — the version held longest; open the row for each` : title,
  });
  switch (keptBy.kind) {
    case "pin": {
      const [first, ...rest] = keptBy.pins;
      const one = rest.length === 0;
      return said(
        `pin ${first ?? ""}${one ? "" : ` +${rest.length}`}`,
        `held by ${one ? "the pin" : "the pins"} ${keptBy.pins.join(", ")}; ` +
          `it stays until ${one ? "the pin is" : "every one of them is"} deleted or re-pointed; ` +
          `after that: ${now > keptBy.until ? "the next collection" : ahead(keptBy.until, now)}`,
      );
    }
    case "retention":
      return said(
        `retention · ${ahead(keptBy.until, now)}`,
        `wanted ${wanted}; the bucket keeps a path ${options.retentionDays} ` +
          `day${options.retentionDays === 1 ? "" : "s"} after the last want; ${leaves}`,
      );
    case "reference":
      return said(
        `reference · ${ahead(keptBy.until, now)}`,
        `${keptBy.via ?? "a path"} still needs it, and was wanted ${wanted}; ${leaves}`,
      );
    case "nothing":
      return said(
        "nothing · next collection",
        `expired ${ago(keptBy.until, now)}; nothing references it and no pin holds it; ` +
          "the daily collection or Run GC takes it",
      );
  }
}

function HashCell(props: { storePath: string }): JSX.Element {
  const [said, setSaid] = createSignal<Copied | null>(null);
  let reset: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(reset));
  const press = (): void => {
    clearTimeout(reset);
    void copyText(props.storePath).then((answer) => {
      setSaid(answer);
      reset = setTimeout(() => setSaid(null), 1400);
    });
  };
  return (
    <button
      type="button"
      class="hash"
      title={props.storePath}
      aria-label={`copy ${props.storePath}`}
      onClick={press}
    >
      {said() ?? storePathParts(props.storePath).hash.slice(0, HASH_SHOWN)}
    </button>
  );
}

function KeptByCell(props: {
  keptBy: CacheKeptBy;
  now: number;
  grouped: boolean;
  retentionDays: number;
}): JSX.Element {
  const said = createMemo(() =>
    keptByText(props.keptBy, props.now, {
      grouped: props.grouped,
      retentionDays: props.retentionDays,
    }),
  );
  return <span title={said().title}>{said().cell}</span>;
}

interface AppendedPages {
  readonly rows: readonly PathRow[];
  readonly next: string | null;
}

function BucketPaths(props: {
  client: CacheClient;
  call: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  bucket: string;
  now: number;
  runHref: (runId: string) => string;
  retentionDays: number;
}): JSX.Element {
  const [typed, setTyped] = createSignal("");
  const [filter, setFilter] = createSignal("");
  let pending: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(typed, (value) => {
      if (pending !== undefined) clearTimeout(pending);
      pending = setTimeout(() => setFilter(value), FILTER_DEBOUNCE_MS);
    }),
  );
  onCleanup(() => {
    if (pending !== undefined) clearTimeout(pending);
  });
  createEffect(
    on(
      () => props.bucket,
      () => {
        if (pending !== undefined) clearTimeout(pending);
        setTyped("");
        setFilter("");
      },
      { defer: true },
    ),
  );

  const [grouped, setGrouped] = createSignal(true);
  const [column, setColumn] = createSignal<PathColumn>("pushed");
  const [descending, setDescending] = createSignal(true);
  const sortBy = (which: PathColumn): void => {
    if (column() === which) setDescending(!descending());
    else {
      setColumn(which);
      setDescending(which !== "name");
    }
  };

  const [appended, setAppended] = createSignal<AppendedPages | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [loadingMore, setLoadingMore] = createSignal(false);

  let generation = 0;
  const current = (): number => generation;
  const supersede = (): number => {
    generation += 1;
    return generation;
  };
  onCleanup(() => {
    supersede();
  });

  const query = (): {
    filter?: string;
    group?: "name";
    sort: PathColumn;
    descending: boolean;
  } => ({
    ...(filter() === "" ? {} : { filter: filter() }),
    ...(grouped() ? { group: "name" as const } : {}),
    sort: column(),
    descending: descending(),
  });

  const retention = createMemo(() => props.retentionDays);

  const [first, { refetch }] = createResource(
    () => ({ asked: { bucket: props.bucket, ...query() }, retentionDays: retention() }),
    async ({ asked, retentionDays }): Promise<FirstPage> => {
      setAppended(null);
      setFailure(null);
      setLoadingMore(false);
      supersede();
      try {
        const page = await props.call(props.client.procedures.bucket.paths(asked));
        return { ok: true, rows: pathRows(page), next: page.next ?? null, retentionDays };
      } catch (err) {
        return { ok: false, message: refusalText(err) };
      }
    },
  );
  const answeredRetention = createMemo(() => {
    const answer = first();
    return answer !== undefined && answer.ok ? answer.retentionDays : retention();
  });

  const more = (after: string): void => {
    const asked = current();
    setLoadingMore(true);
    setFailure(null);
    void props
      .call(props.client.procedures.bucket.paths({ bucket: props.bucket, ...query(), after }))
      .then(
        (answer) => {
          if (asked !== current()) return;
          setLoadingMore(false);
          setAppended((been) => ({
            rows: [...(been?.rows ?? []), ...pathRows(answer)],
            next: answer.next ?? null,
          }));
        },
        (err: unknown) => {
          if (asked !== current()) return;
          setLoadingMore(false);
          setFailure(refusalText(err));
        },
      );
  };

  const refusal = createMemo<string | null>(() => {
    const answer = first();
    return answer === undefined || answer.ok ? null : answer.message;
  });

  const stable = keepIdentity<PathRow>((row) => row.storePath);
  const rows = createMemo<readonly PathRow[]>(() => {
    const answer = first();
    if (answer === undefined || !answer.ok) return [];
    return [...answer.rows, ...(appended()?.rows ?? [])].map(stable);
  });
  const next = createMemo<string | null>(() => {
    const been = appended();
    if (been !== null) return been.next;
    const answer = first();
    return answer !== undefined && answer.ok ? answer.next : null;
  });

  const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set());
  const [versions, setVersions] = createSignal<ReadonlyMap<string, Versions>>(new Map());
  const held = (name: string, state: Versions): void => {
    setVersions((all) => new Map(all).set(name, state));
  };
  const openState = (name: string): Versions | undefined =>
    opened().has(name) ? versions().get(name) : undefined;
  const readVersions = (name: string, after: string | null): void => {
    const asked = current();
    const standing = versions().get(name);
    held(
      name,
      after === null || standing?.kind !== "held"
        ? { kind: "reading" }
        : { ...standing, reading: true },
    );
    void props
      .call(
        props.client.procedures.bucket.paths({
          bucket: props.bucket,
          name,
          ...(filter() === "" ? {} : { filter: filter() }),
          ...(after === null ? {} : { after }),
          sort: "pushed",
          descending: true,
        }),
      )
      .then(
        (answer) => {
          if (asked !== current()) return;
          const drawn = versions().get(name);
          const before = after !== null && drawn?.kind === "held" ? drawn.versions : [];
          held(name, {
            kind: "held",
            versions: [...before, ...answer.paths],
            next: answer.next ?? null,
            reading: false,
          });
        },
        (err: unknown) => {
          if (asked !== current()) return;
          held(name, { kind: "failed", message: refusalText(err) });
        },
      );
  };
  const toggleOpen = (name: string): void => {
    const open = !opened().has(name);
    setOpened((all) => {
      const next = new Set(all);
      if (open) next.add(name);
      else next.delete(name);
      return next;
    });
    if (!open || versions().has(name)) return;
    readVersions(name, null);
  };

  const columns: ReadonlyArray<TableColumn<PathRow>> = [
    {
      key: "name",
      label: "name",
      sortable: true,
      cell: (row) =>
        row.versions > 1 ? (
          <button
            type="button"
            class="disclosure-summary"
            aria-expanded={opened().has(row.name)}
            onClick={() => toggleOpen(row.name)}
          >
            <span class="name">{row.name}</span>
            {}
            <span class="versions">· {row.versions} versions</span>
          </button>
        ) : (
          <span class="name">{row.name}</span>
        ),
    },
    {
      key: "hash",
      label: "hash",
      width: "6rem",
      cell: (row) => <HashCell storePath={row.storePath} />,
    },
    {
      key: "size",
      label: "size",
      align: "right",
      width: "5rem",
      sortable: true,
      cell: (row) => bytes(row.bytes),
    },
    {
      key: "pushed",
      label: "pushed",
      align: "right",
      width: "5.5rem",
      sortable: true,
      cell: (row) => ago(row.pushed, props.now),
    },
    {
      key: "reads",
      label: "reads",
      align: "right",
      width: "4rem",
      sortable: true,
      cell: (row) => row.hits,
    },
    {
      key: "commit",
      label: "commit",
      width: "5rem",
      cell: (row) =>
        row.commit === null ? null : <span title={row.commit}>{row.commit.slice(0, SHA_SHOWN)}</span>,
    },
    {
      key: "run",
      label: "run",
      width: "6rem",
      cell: (row) =>
        row.run === null ? null : (
          <a class="link" href={props.runHref(row.run)} title={row.run}>
            {row.run}
          </a>
        ),
    },
    {
      key: "wanted",
      label: "wanted",
      align: "right",
      width: "5.5rem",
      cell: (row) => ago(row.wanted, props.now),
    },
    {
      key: "keptBy",
      label: "kept by",
      width: "11rem",
      cell: (row) =>
        row.keptBy === null ? null : (
          <KeptByCell
            keptBy={row.keptBy}
            now={props.now}
            grouped={row.versions > 1}
            retentionDays={answeredRetention()}
          />
        ),
    },
  ];
  const versionsOf = (row: PathRow): readonly PathRow[] => {
    const state = openState(row.name);
    if (state === undefined || state.kind !== "held") return [];
    return state.versions.map((version) => pathRow(version, ""));
  };
  const noteUnder = (row: PathRow): JSX.Element | null => {
    const state = openState(row.name);
    if (state === undefined) return null;
    if (state.kind === "reading") return "reading…";
    if (state.kind === "failed") return <span class="fault">{state.message}</span>;
    if (state.next === null) return null;
    const rest = row.versions - state.versions.length;
    return (
      <button
        type="button"
        class="text-action"
        disabled={state.reading}
        onClick={() => readVersions(row.name, state.next)}
      >
        {state.reading
          ? "reading…"
          : `show ${rest > PATH_PAGE_SIZE || rest <= 0 ? PATH_PAGE_SIZE : rest} more`}
      </button>
    );
  };
  const forgetVersions = (): void => {
    setOpened(new Set<string>());
    setVersions(new Map());
  };
  createEffect(
    on(
      () => [props.bucket, filter(), retention()] as const,
      forgetVersions,
      { defer: true },
    ),
  );

  return (
    <Panel
      class="cache-paths"
      title="Paths"
      label="paths"
      actions={
        <>
          <SearchInput
            label="filter paths"
            value={typed()}
            placeholder="filter by path, e.g. openssl"
            onValue={setTyped}
          />
          {}
          <button
            type="button"
            class="text-action"
            aria-pressed={grouped()}
            onClick={() => setGrouped(!grouped())}
          >
            group by name
          </button>
          {}
          <button
            type="button"
            class="text-action"
            disabled={first.loading}
            onClick={() => {
              forgetVersions();
              void refetch();
            }}
          >
            {first.loading ? "reading…" : "refresh paths"}
          </button>
        </>
      }
    >
      {}
      <Show when={refusal() ?? failure()}>
        {(message) => (
          <div class="panel-body">
            <Receipt tone="refused">{message()}</Receipt>
            <button type="button" class="text-action" onClick={() => refetch()}>
              try again
            </button>
          </div>
        )}
      </Show>
      <Show
        when={rows().length > 0}
        fallback={
          <Show when={refusal() === null && failure() === null}>
            <p class="panel-body hint">
              {first.loading
                ? "reading…"
                : filter() === ""
                  ? "Nothing pushed to this bucket yet."
                  : "No path matches that filter."}
            </p>
          </Show>
        }
      >
        {}
        <div class="paths-scroll">
          <Table
            class="paths-table"
            label="paths"
            columns={columns}
            rows={rows()}
            sorted={{ key: column(), descending: descending() }}
            onSort={(key) => sortBy(key as PathColumn)}
            under={(row) => versionsOf(row)}
            note={(row) => noteUnder(row)}
          />
        </div>
      </Show>
      <Show when={next()}>
        {(after) => (
          <div class="panel-foot">
            <Button disabled={loadingMore() || first.loading} onClick={() => more(after())}>
              {loadingMore() ? "reading…" : `Show ${PATH_PAGE_SIZE} more`}
            </Button>
          </div>
        )}
      </Show>
    </Panel>
  );
}

function BucketPage(
  props: AdminProps &
    TokenField & {
      name: string;
      now: number;
      onOpen: (bucket: string | null) => void;
      canAdminister: boolean;
      local: boolean;
      tunnelRow: boolean;
      pushActionRef: () => string | null;
      runHref: (runId: string) => string;
    },
): JSX.Element {
  const pushActionRef = (): string => props.pushActionRef() ?? ACTION_REF_PLACEHOLDER;

  const admin: AdminProps = {
    get client() {
      return props.client;
    },
    get call() {
      return props.call;
    },
    rootToken: () => props.rootToken(),
    armed: () => props.armed(),
  };

  const [tab, setTab] = createSignal<SetupDestination>(SETUP_TABS[0]);

  const [minted, setMinted] = createSignal<Minted | null>(null);
  createEffect(on(() => props.name, () => setMinted(null), { defer: true }));

  const buckets = props.client.collections.buckets.use();
  const bucket = createMemo<CacheBucket | undefined>(() => buckets.byKey(props.name)?.());

  const [listing, setListing] = createSignal<BucketTab>("Paths");
  const shown = (): BucketTab => (props.canAdminister ? listing() : "Paths");

  const clockWhile = (which: BucketTab): (() => number) =>
    createMemo<number>((prev) => (shown() === which ? props.now : prev), props.now);
  const pathsClock = clockWhile("Paths");
  const pinsClock = clockWhile("Pins");

  const setupText = createMemo<string>(() => {
    const row = bucket();
    if (row === undefined) return "";
    return tab().text({
      url: row.url,
      publicKey: row.publicKey,
      public: row.public,
      bucket: props.name,
      token: minted()?.scope === "write" ? (minted()?.token ?? null) : null,
      ref: pushActionRef(),
    });
  });

  return (
    <section class="screen cache" aria-label={`bucket ${props.name}`}>
      <p class="crumbs">
        <BackLink onClick={() => props.onOpen(null)}>Cache</BackLink>
      </p>
      <PageHead
        title={props.name}
        mono
        actions={
          <Show when={bucket()}>
            {(row) => (
              <div class="page-actions">
                <Tag>{row().store}</Tag>
                <Tag>{row().public ? "public" : "private"}</Tag>
                <Show when={row().domain}>
                  {}
                  {(domain) => <Tag>{domain()}</Tag>}
                </Show>
              </div>
            )}
          </Show>
        }
        sub={
          <Show when={bucket()}>
            {(row) => (
              <>
                {}
                <span>
                  <b>{row().objects}</b> paths
                </span>
                <span>
                  <b>{bytes(row().bytes)}</b> stored
                </span>
                <span>
                  <b>{row().hits}</b> reads
                </span>
                <span>
                  {row().lastPush === null
                    ? "nothing pushed"
                    : `pushed ${ago(row().lastPush ?? 0, props.now)}`}
                </span>
                <Show when={row().retentionDays > 0}>
                  <span>{row().retentionDays}d retention</span>
                </Show>
                {}
                <span>objects on {row().store}</span>
                {}
                <span>{readsFromText(row())}</span>
                {}
                <span>
                  {row().upstreamKeys.length === 0
                    ? "no upstream filter"
                    : `skips ${row().upstreamKeys.join(", ")}`}
                </span>
              </>
            )}
          </Show>
        }
      />
      <Show
        when={bucket()}
        fallback={
          <p class="empty">This bucket is not on the board — it may have been removed.</p>
        }
      >
        {(row) => (
          <div class="split">
            <div class="split-main">
              {}
              <Show when={props.canAdminister}>
                <div class="tabs" role="tablist" aria-label="what is in it">
                  <For each={BUCKET_TABS}>
                    {(which) => (
                      <button
                        type="button"
                        role="tab"
                        class="tab"
                        id={`bucket-tab-${which}`}
                        aria-controls={`bucket-panel-${which}`}
                        aria-selected={shown() === which}
                        onClick={() => setListing(which)}
                      >
                        {which}
                      </button>
                    )}
                  </For>
                </div>
              </Show>

              {}
              <div
                class="tab-host"
                id="bucket-panel-Paths"
                role={props.canAdminister ? "tabpanel" : undefined}
                aria-labelledby={props.canAdminister ? "bucket-tab-Paths" : undefined}
                hidden={shown() !== "Paths"}
              >
                <BucketPaths
                  client={props.client}
                  call={props.call}
                  bucket={props.name}
                  runHref={props.runHref}
                  now={pathsClock()}
                  retentionDays={bucket()?.retentionDays ?? DEFAULT_RETENTION_DAYS}
                />
              </div>
              {}
              <Show when={props.canAdminister ? props.name : null} keyed>
                {(name) => (
                  <div
                    class="tab-host"
                    role="tabpanel"
                    id="bucket-panel-Pins"
                    aria-labelledby="bucket-tab-Pins"
                    hidden={shown() !== "Pins"}
                  >
                    <BucketPins {...admin} name={name} now={pinsClock()} />
                  </div>
                )}
              </Show>

              {}
              <Panel
                class="cache-setup"
                title="Set up"
                label="set up"
                actions={<CopyButton text={setupText()} />}
              >
                <KeyValue label="substituter" value={row().url}>
                  <CopyButton text={row().url} />
                </KeyValue>
                <KeyValue label="public key" value={row().publicKey}>
                  <CopyButton text={row().publicKey} />
                </KeyValue>
                <div class="tabs" role="tablist" aria-label="where to put it">
                  <For each={SETUP_TABS}>
                    {(where) => (
                      <button
                        type="button"
                        role="tab"
                        class="tab"
                        aria-selected={tab().name === where.name}
                        onClick={() => setTab(where)}
                      >
                        {where.name}
                      </button>
                    )}
                  </For>
                </div>
                <pre
                  class={`use-block ${tab().blockClass}`}
                  role="tabpanel"
                  aria-label={tab().name}
                >
                  {setupText()}
                </pre>
                <Show when={tab().note}>{(note) => <p class="hint">{note()}</p>}</Show>
              </Panel>
            </div>

            {}
            <Show when={props.canAdminister ? props.name : null} keyed>
              {(name) => (
                <div class="split-side">
                  <Show when={props.local}>
                    {}
                    <Panel
                      title="Root token"
                      actions={
                        <Show when={props.armed()}>
                          <Tag>administering</Tag>
                        </Show>
                      }
                    >
                      <div class="panel-body">
                        <RootTokenField
                          typedToken={props.typedToken}
                          onTypedToken={props.onTypedToken}
                        />
                      </div>
                    </Panel>
                  </Show>
                  {}
                  <Show when={props.armed()}>
                    <BucketTokens
                      {...admin}
                      minted={minted()}
                      onMinted={setMinted}
                      name={name}
                      now={props.now}
                    />
                    <BucketRetention
                      {...admin}
                      name={name}
                      retentionDays={bucket()?.retentionDays ?? DEFAULT_RETENTION_DAYS}
                    />
                    <BucketDomain
                      {...admin}
                      name={name}
                      domain={bucket()?.domain ?? null}
                      tunnelRow={props.tunnelRow}
                    />
                    <BucketMigrate
                      {...admin}
                      name={name}
                      store={bucket()?.store ?? LOCAL_STORE}
                      migration={bucket()?.migration ?? null}
                    />
                    <BucketGc
                      {...admin}
                      name={name}
                      now={props.now}
                      retentionDays={bucket()?.retentionDays ?? DEFAULT_RETENTION_DAYS}
                    />
                    {}
                    <div class="danger-zone">
                      <h2 class="danger-zone-head">Danger zone</h2>
                      <BucketDelete
                        {...admin}
                        name={name}
                        onDeleted={() => props.onOpen(null)}
                      />
                    </div>
                  </Show>
                </div>
              )}
            </Show>
          </div>
        )}
      </Show>
    </section>
  );
}

function Answer(props: { control: Control }): JSX.Element {
  return (
    <>
      <Show when={props.control.fault()}>
        {(message) => <Receipt tone="refused">{message()}</Receipt>}
      </Show>
      <Show when={props.control.done()}>
        {(message) => <Receipt tone="ok">{message()}</Receipt>}
      </Show>
    </>
  );
}

type Reading<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

interface Read<T> {
  value: () => T | null;
  fault: () => string | null;
  loading: () => boolean;
  refetch: () => void;
}

function reading<T>(
  key: () => string | null,
  gate: Pick<AdminProps, "rootToken" | "armed">,
  ask: (bucket: string) => Promise<T>,
): Read<T> {
  const [answer, { refetch }] = createResource(
    () => {
      const named = key();
      if (named === null || !gate.armed()) return null;
      return [named, gate.rootToken()] as const;
    },
    async ([bucket]): Promise<Reading<T>> => {
      try {
        return { ok: true, value: await ask(bucket) };
      } catch (err) {
        return { ok: false, message: refusalText(err) };
      }
    },
  );
  const held = createMemo<Reading<T> | undefined>(() => answer());
  return {
    value: () => {
      const one = held();
      return one !== undefined && one.ok ? one.value : null;
    },
    fault: () => {
      const one = held();
      return one === undefined || one.ok ? null : one.message;
    },
    loading: () => answer.loading,
    refetch: () => void refetch(),
  };
}

function tokenLife(token: CacheToken, now: number): string {
  if (token.revoked) return "revoked";
  const used = token.lastUsed === null ? "never used" : `last used ${ago(token.lastUsed, now)}`;
  const expires =
    token.expires === null
      ? "no expiry"
      : token.expires <= now
        ? `expired ${new Date(token.expires).toISOString().slice(0, 10)}`
        : `expires ${new Date(token.expires).toISOString().slice(0, 10)}`;
  return `${used} · ${expires} · created ${ago(token.created, now)}`;
}


interface Minted {
  readonly id: string;
  readonly token: string;
  readonly scope: CacheScope;
}

type TokenProps = AdminProps & {
  name: string;
  now: number;
  minted: Minted | null;
  onMinted: (minted: Minted | null) => void;
};


function BucketDomain(
  props: AdminProps & { name: string; domain: string | null; tunnelRow: boolean },
): JSX.Element {
  const [typed, setTyped] = createSignal(props.domain ?? "");
  createEffect(on(() => props.domain, (domain) => setTyped(domain ?? ""), { defer: true }));
  const action = createControl(props.call);
  const apply = (domain: string | null): void => {
    action.run(
      props.client.procedures.bucket.domain({
        rootToken: props.rootToken(),
        bucket: props.name,
        ...(domain === null ? {} : { domain }),
      }),
      (row) =>
        row.domain === null
          ? `Cleared the name; ${props.name} is served under /cache/${props.name}.`
          : props.tunnelRow
            ? `Named this bucket ${row.domain}. The tunnel row is wiring its route.`
            : `Named this bucket ${row.domain}. Point its DNS record here.`,
    );
  };
  return (
    <Panel title="Domain" label="domain">
      <div class="panel-body">
        <div class="stack">
          <Field id="bucket-domain" label="domain">
            <TextInput
              id="bucket-domain"
              value={typed()}
              placeholder="cache.example.org"
              onValue={setTyped}
            />
          </Field>
          <div class="stack-row">
            <Button
              class="btn-primary"
              disabled={action.busy()}
              onClick={() => apply(typed().trim())}
            >
              {action.busy() ? "working…" : "Set domain"}
            </Button>
            <Show when={props.domain !== null}>
              <Button disabled={action.busy()} onClick={() => apply(null)}>
                Clear domain
              </Button>
            </Show>
          </div>
          <Answer control={action} />
        </div>
      </div>
    </Panel>
  );
}

function BucketRetention(
  props: AdminProps & { name: string; retentionDays: number },
): JSX.Element {
  const [typed, setTyped] = createSignal(String(props.retentionDays));
  createEffect(
    on(() => props.retentionDays, (days) => setTyped(String(days)), { defer: true }),
  );
  const days = createMemo<number | null>(() => {
    const parsed = Number(typed().trim());
    return typed().trim() === "" || !Number.isInteger(parsed) ? null : parsed;
  });
  const action = createControl(props.call);
  const apply = (): void => {
    const asked = days();
    if (asked === null) return;
    action.run(
      props.client.procedures.bucket.retention({
        rootToken: props.rootToken(),
        bucket: props.name,
        retentionDays: asked,
      }),
      (row) =>
        row.retentionDays === 0
          ? `${row.name} now keeps only what a reference or a pin holds.`
          : `${row.name} now keeps a path ${row.retentionDays} day${row.retentionDays === 1 ? "" : "s"} after the last time anything wanted it.`,
    );
  };
  return (
    <Panel
      title="Retention"
      label="retention"
      actions={<DocsLink />}
    >
      <div class="panel-body">
        <div class="stack">
          <Field id="retention-days" label="retention days">
            <input
              id="retention-days"
              type="number"
              class="input"
              min="0"
              step="1"
              value={typed()}
              onInput={(event) => setTyped(event.currentTarget.value)}
            />
          </Field>
          <Button
            class="btn-primary"
            disabled={action.busy() || days() === null}
            onClick={apply}
          >
            {action.busy() ? "working…" : "Set retention"}
          </Button>
          <Answer control={action} />
        </div>
      </div>
    </Panel>
  );
}

export function migrationText(migration: CacheMigration): string {
  const progress =
    `${migration.copied} of ${migration.total} object${migration.total === 1 ? "" : "s"}` +
    `, ${bytes(migration.bytes)}`;
  switch (migration.state) {
    case "copying":
      return `Copying to ${migration.to}: ${progress}.`;
    case "flipping":
      return `Flipping to ${migration.to}: ${progress}.`;
    default:
      return `Deleting the old copies on the way to ${migration.to}: ${progress}.`;
  }
}

function BucketMigrate(
  props: AdminProps & {
    name: string;
    store: string;
    migration: CacheMigration | null;
  },
): JSX.Element {
  const stores = props.client.cells.stores.use();
  const elsewhere = createMemo(() =>
    (stores.value() ?? []).filter((one) => one.name !== props.store),
  );
  const [picked, setPicked] = createSignal<string | null>(null);
  const target = createMemo(() => {
    const chosen = picked();
    const offered = elsewhere();
    return chosen !== null && offered.some((one) => one.name === chosen)
      ? chosen
      : (offered[0]?.name ?? "");
  });
  const action = createControl(props.call);
  const start = (): void => {
    const to = target();
    if (to === "") return;
    action.run(
      props.client.procedures.bucket.migrate({
        rootToken: props.rootToken(),
        bucket: props.name,
        store: to,
      }),
      (row) =>
        `Moving ${row.name} to ${row.migration?.to ?? to}. It keeps serving from ${row.store} until every object is copied.`,
    );
  };
  return (
    <Show when={props.migration !== null || elsewhere().length > 0}>
      <Panel title="Move to another store" label="migrate" actions={<DocsLink />}>
        <div class="panel-body">
          <div class="stack">
            <Show
              when={props.migration}
              fallback={
                <>
                  <fieldset class="toggles">
                    <legend>where to move it</legend>
                    <div class="form-pair">
                      <For each={elsewhere()}>
                        {(one) => (
                          <Choice
                            name="migrate-store"
                            value={one.name}
                            checked={target() === one.name}
                            label={one.name}
                            note={one.kind === "local" ? "this server's disk" : "an S3 store"}
                            onPick={(name) => setPicked(name)}
                          />
                        )}
                      </For>
                    </div>
                  </fieldset>
                  <Button class="btn-primary" disabled={action.busy()} onClick={start}>
                    {action.busy() ? "starting…" : "Start move"}
                  </Button>
                </>
              }
            >
              {(moving) => <p class="hint migration-progress">{migrationText(moving())}</p>}
            </Show>
            <Answer control={action} />
          </div>
        </div>
      </Panel>
    </Show>
  );
}

function BucketTokens(props: TokenProps): JSX.Element {
  const [scope, setScope] = createSignal<"write" | "read">("write");
  const [expiry, setExpiry] = createSignal("90");
  const minted = (): Minted | null => props.minted;
  const setMinted = props.onMinted;
  const action = createControl(props.call);

  const tokens = reading(
    () => props.name,
    props,
    async (bucket) =>
      (await props.call(props.client.procedures.token.list({ rootToken: props.rootToken(), bucket })))
        .tokens,
  );
  const listed = (): readonly CacheToken[] => tokens.value() ?? [];

  const mint = (): void => {
    const chosen = scope();
    action.run(
      props.client.procedures.token.mint({
        rootToken: props.rootToken(),
        bucket: props.name,
        scope: chosen,
        ...(expiry() === "never" ? {} : { expiresDays: Number(expiry()) }),
      }),
      (answer) => {
        setMinted({ id: answer.facts.id, token: answer.token, scope: answer.facts.scope });
        tokens.refetch();
        return expiry() === "never"
          ? `Minted a ${chosen} token for ${props.name}, with no expiry.`
          : `Minted a ${chosen} token for ${props.name}, expiring in ${expiry()} days.`;
      },
    );
  };
  const revoke = (id: string): void => {
    action.run(
      props.client.procedures.token.revoke({ rootToken: props.rootToken(), id }),
      () => {
        if (minted()?.id === id) setMinted(null);
        tokens.refetch();
        return `Revoked ${id}.`;
      },
    );
  };

  return (
    <Panel title="Tokens" label="tokens">
      <div class="panel-body">
        <div class="stack">
          <div class="stack-row">
            {}
            <label class="field-inline">
              <span>scope</span>
              <select
                class="input"
                aria-label="token scope"
                value={scope()}
                onChange={(event) =>
                  setScope(event.currentTarget.value === "read" ? "read" : "write")
                }
              >
                <option value="write">write — push</option>
                <option value="read">read — substitute</option>
              </select>
            </label>
            <label class="field-inline">
              <span>expiry</span>
              <select
                class="input"
                aria-label="token expiry"
                value={expiry()}
                onChange={(event) => setExpiry(event.currentTarget.value)}
              >
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
                <option value="never">never</option>
              </select>
            </label>
          </div>
          <Button class="btn-primary" disabled={action.busy()} onClick={mint}>
            {action.busy() ? "working…" : "Mint token"}
          </Button>
          <Answer control={action} />
          <Show when={minted()}>
            {(held) => (
              <>
                <p class="hint">shown once</p>
                <pre class="use-block minted-token">{held().token}</pre>
              </>
            )}
          </Show>
          <Show when={tokens.fault()}>
            {(message) => <Receipt tone="refused">{message()}</Receipt>}
          </Show>
          <Show
            when={listed().length > 0}
            fallback={
              <Show when={tokens.fault() === null}>
                <p class="hint">
                  {tokens.loading() ? "reading…" : "No tokens for this bucket yet."}
                </p>
              </Show>
            }
          >
            <ul class="tokens">
              <For each={listed()}>
                {(token) => (
                  <li>
                    <span class="field">
                      <span>
                        <code>{token.id}</code> <Tag>{token.scope}</Tag>
                        <Show when={token.id === minted()?.id}>
                          {}
                          <Pill hue="amber">just minted</Pill>
                        </Show>
                        <Show when={token.bucketGlob !== props.name}>
                          <Tag>{token.bucketGlob}</Tag>
                        </Show>
                        {}
                        <Show when={token.label}>
                          {(label) => <Tag>{label()}</Tag>}
                        </Show>
                      </span>
                      <span class="hint">{tokenLife(token, props.now)}</span>
                    </span>
                    <Show when={!token.revoked}>
                      {}
                      <button
                        type="button"
                        class="text-action"
                        aria-label={`revoke ${token.id}`}
                        disabled={action.busy()}
                        onClick={() => revoke(token.id)}
                      >
                        revoke
                      </button>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </div>
    </Panel>
  );
}

function pathsOf(raw: string): string[] {
  return raw.split(/\s+/).filter((one) => one !== "");
}

export interface PinName {
  readonly repo: string | null;
  readonly ref: string;
  readonly system: string | null;
}

export function pinName(name: string): PinName {
  const whole: PinName = { repo: null, ref: name, system: null };
  const at = name.indexOf("@");
  if (at <= 0) return whole;

  const repo = name.slice(0, at);
  const slash = repo.indexOf("/");
  if (slash <= 0 || slash === repo.length - 1) return whole;
  if (repo.indexOf("/", slash + 1) !== -1) return whole;
  if (hasSpace(repo)) return whole;

  const rest = name.slice(at + 1);
  const last = rest.lastIndexOf("/");
  if (last <= 0 || last === rest.length - 1) return whole;
  const system = rest.slice(last + 1);
  if (!system.includes("-") || hasSpace(system)) return whole;

  return { repo, ref: rest.slice(0, last), system };
}

function hasSpace(text: string): boolean {
  for (const ch of text) if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") return true;
  return false;
}

function BucketPins(props: AdminProps & { name: string; now: number }): JSX.Element {
  const [pin, setPin] = createSignal("");
  const [paths, setPaths] = createSignal("");
  const action = createControl(props.call);

  const pins = reading(
    () => props.name,
    props,
    async (bucket) =>
      (await props.call(props.client.procedures.pin.list({ rootToken: props.rootToken(), bucket })))
        .pins,
  );
  const listed = (): readonly CachePin[] => pins.value() ?? [];

  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const [showing, setShowing] = createSignal<ReadonlySet<string>>(new Set());
  const toggleRoots = (key: string): void => {
    setShowing((all) => {
      const next = new Set(all);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };
  const closureKey = (pin: CachePin): string => `${pin.name}@${pin.created}`;
  const showAll = (key: string): void => {
    setExpanded((held) => new Set(held).add(key));
  };

  const create = (): void => {
    const name = pin().trim();
    const roots = pathsOf(paths());
    action.run(
      props.client.procedures.pin.create({
        rootToken: props.rootToken(),
        bucket: props.name,
        name,
        paths: roots,
      }),
      (answer) => {
        setPin("");
        setPaths("");
        return answer.rootPaths.length === 1
          ? `Pinned ${answer.name}: 1 path in its closure is kept from GC.`
          : `Pinned ${answer.name}: ${answer.rootPaths.length} paths in its closure are kept from GC.`;
      },
      pins.refetch,
    );
  };
  const unpin = (name: string): void => {
    action.run(
      props.client.procedures.pin.delete({
        rootToken: props.rootToken(),
        bucket: props.name,
        name,
      }),
      (answer) =>
        `Unpinned ${answer.name}; its closure is now retention's to collect like any other path.`,
      pins.refetch,
    );
  };

  const [forming, setForming] = createSignal(false);

  const columns: ReadonlyArray<TableColumn<CachePin>> = [
    {
      key: "name",
      label: "name",
      cell: (held) => (
        <button
          type="button"
          class="disclosure-summary"
          aria-expanded={showing().has(closureKey(held))}
          onClick={() => toggleRoots(closureKey(held))}
        >
          {}
          <span class="name">
            <Show when={pinName(held.name).repo}>
              {(repo) => <span class="muted">{repo()}@</span>}
            </Show>
            {pinName(held.name).ref}
          </span>
        </button>
      ),
    },
    {
      key: "system",
      label: "system",
      width: "8rem",
      cell: (held) => {
        const system = pinName(held.name).system;
        return system === null ? <span class="muted">—</span> : <code>{system}</code>;
      },
    },
    {
      key: "paths",
      label: "paths",
      align: "right",
      width: "4rem",
      cell: (held) => held.rootPaths.length,
    },
    {
      key: "pinned",
      label: "pinned",
      align: "right",
      width: "5.5rem",
      cell: (held) => ago(held.created, props.now),
    },
    {
      key: "by",
      label: "by",
      align: "right",
      width: "5.5rem",
      cell: (held) => (held.createdBy === "write" ? "a push" : "an admin"),
    },
    {
      key: "unpin",
      label: "",
      align: "right",
      width: "4rem",
      cell: (held) => (
        <button
          type="button"
          class="text-action"
          aria-label={`unpin ${held.name}`}
          disabled={action.busy()}
          onClick={() => unpin(held.name)}
        >
          unpin
        </button>
      ),
    },
  ];

  const rootsUnder = (held: CachePin): JSX.Element | null => {
    if (!showing().has(closureKey(held))) return null;
    const all = expanded().has(closureKey(held));
    const shown = all ? held.rootPaths : held.rootPaths.slice(0, PIN_ROOTS_SHOWN);
    return (
      <span class="pin-roots" data-pin={held.name}>
        <For each={shown}>{(root) => <code class="path">{root}</code>}</For>
        <Show when={shown.length < held.rootPaths.length}>
          <button type="button" class="text-action" onClick={() => showAll(closureKey(held))}>
            show all {held.rootPaths.length}
          </button>
        </Show>
      </span>
    );
  };

  return (
    <Panel
      class="cache-pins"
      title="Pins"
      label="pins"
      actions={
        <>
          <button
            type="button"
            class="text-action"
            disabled={pins.loading()}
            onClick={pins.refetch}
          >
            {pins.loading() ? "reading…" : "refresh pins"}
          </button>
          <DocsLink />
        </>
      }
    >
      <div class="panel-body">
        <div class="stack">
          <Disclosure
            summary="Pin a closure"
            open={forming()}
            onToggle={() => setForming((open) => !open)}
          >
            <Fields>
              <Field id="pin-name" label="pin name">
                <TextInput id="pin-name" value={pin()} placeholder="release-1.2" onValue={setPin} />
              </Field>
              <Field id="pin-paths" label="store paths" hint="space or newline separated">
                <textarea
                  id="pin-paths"
                  class="input"
                  rows={3}
                  placeholder="/nix/store/…"
                  value={paths()}
                  onInput={(event) => setPaths(event.currentTarget.value)}
                />
              </Field>
              <Button class="btn-primary" disabled={action.busy()} onClick={create}>
                {action.busy() ? "pinning…" : "Pin closure"}
              </Button>
            </Fields>
          </Disclosure>
          <Answer control={action} />
          <Show when={pins.fault()}>{(message) => <p class="fault">{message()}</p>}</Show>
          <Show
            when={listed().length > 0}
            fallback={
              <Show when={pins.fault() === null}>
                {}
                <p class="hint">
                  {!props.armed()
                    ? "root token needed"
                    : pins.loading()
                      ? "reading…"
                      : "Nothing is pinned in this bucket."}
                </p>
              </Show>
            }
          >
            <Table
              class="pins-table"
              label="pins"
              columns={columns}
              rows={listed()}
              note={rootsUnder}
            />
          </Show>
        </div>
      </div>
    </Panel>
  );
}

const PIN_ROOTS_SHOWN = 10;


function BucketGc(
  props: AdminProps & { name: string; now: number; retentionDays: number },
): JSX.Element {
  const action = createControl(props.call);
  const [retention, setRetention] = createSignal("");
  const asking = createMemo<{ kind: "own" } | { kind: "days"; days: number } | { kind: "bad" }>(
    () => {
      const typed = retention().trim();
      if (typed === "") return { kind: "own" };
      const parsed = Number(typed);
      return Number.isInteger(parsed) ? { kind: "days", days: parsed } : { kind: "bad" };
    },
  );
  const [asked, setAsked] = createSignal(false);
  const [answeredWith, setAnsweredWith] = createSignal<number | null>(null);
  const plan = reading(
    () => (asked() ? props.name : null),
    props,
    async (bucket) => {
      const days = asking();
      const override = days.kind === "days" ? days.days : null;
      const answer = await props.call(
        props.client.procedures.gc.plan({
          rootToken: props.rootToken(),
          bucket,
          ...(override === null ? {} : { retentionDays: override }),
        }),
      );
      setAnsweredWith(override);
      return answer;
    },
  );
  const askAgain = (): void => {
    if (!asked()) setAsked(true);
    else plan.refetch();
  };
  const next = (): CacheGcPlan["buckets"][number] | null =>
    plan.value()?.buckets.find((row) => row.bucket === props.name) ?? null;
  const [stopped, setStopped] = createSignal<string | null>(null);
  const collect = (): void => {
    setStopped(null);
    action.run(
      props.client.procedures.gc.run({ rootToken: props.rootToken(), bucket: props.name }),
      (report) => {
        setStopped(report.stopped);
        return (
          `Collected: evicted ${report.evicted} path${report.evicted === 1 ? "" : "s"}` +
          `${report.kept > 0 ? ` (${report.kept} whose bytes a twin path still names)` : ""}` +
          `, freed ${bytes(report.bytes)}` +
          `${report.orphans > 0 ? ` and ${report.orphans} orphaned object${report.orphans === 1 ? "" : "s"}` : ""}.`
        );
      },
      () => {
        if (asked()) plan.refetch();
      },
    );
  };
  return (
    <Panel
      title="Garbage collection"
      label="garbage collection"
      actions={<DocsLink />}
    >
      <div class="panel-body">
        <div class="stack">
          <div class="control-row">
            <Button disabled={action.busy()} onClick={collect}>
              {action.busy() ? "collecting…" : "Run GC"}
            </Button>
            {}
            <Button disabled={plan.loading() || asking().kind === "bad"} onClick={askAgain}>
              {plan.loading()
                ? "counting…"
                : asking().kind === "own"
                  ? "Dry run"
                  : `Dry run at ${retention().trim()} day${retention().trim() === "1" ? "" : "s"}`}
            </Button>
            {}
            <Field id="gc-retention-days" label="retention">
              <input
                id="gc-retention-days"
                type="number"
                class="input"
                min="0"
                step="1"
                placeholder={`bucket's (${props.retentionDays}d)`}
                value={retention()}
                onInput={(event) => setRetention(event.currentTarget.value)}
              />
            </Field>
          </div>
          <Answer control={action} />
          {}
          <Show when={stopped()}>{(why) => <Receipt tone="refused">{why()}</Receipt>}</Show>
          <Show when={plan.fault()}>{(message) => <p class="fault">{message()}</p>}</Show>
          <Show when={next()}>
            {(would) => (
              <>
                <p class="hint">
                  {}
                  {answeredWith() === null
                    ? "The next collection"
                    : `At ${answeredWith() as number} day${answeredWith() === 1 ? "" : "s"}' retention — the bucket keeps its own — the next collection`}
                  {would().evicted === 0
                    ? " would take nothing here: every path is retained, referenced or pinned."
                    : ` would take ${would().evicted} path${would().evicted === 1 ? "" : "s"} and free ${bytes(would().bytes)}, leaving ${would().remaining} path${would().remaining === 1 ? "" : "s"} here.`}
                </p>
                <Show when={would().paths.length > 0}>
                  <ol class="paths">
                    <For each={would().paths}>
                      {(path) => (
                        <li>
                          <code class="path">{path.storePath}</code>
                          <span class="fact-line bucket-facts">
                            <span>{bytes(path.bytes)}</span>
                            <span>wanted {ago(path.lastWanted, props.now)}</span>
                          </span>
                        </li>
                      )}
                    </For>
                  </ol>
                  <Show when={would().evicted > would().paths.length}>
                    <p class="hint">
                      {would().paths.length} oldest wants listed
                    </p>
                  </Show>
                </Show>
              </>
            )}
          </Show>
        </div>
      </div>
    </Panel>
  );
}

function BucketDelete(
  props: AdminProps & { name: string; onDeleted: () => void },
): JSX.Element {
  const [typed, setTyped] = createSignal("");
  const action = createControl(props.call);
  const confirmed = createMemo(() => typed() === props.name);
  createEffect(
    on(action.done, (message) => {
      if (message !== null) props.onDeleted();
    }, { defer: true }),
  );
  const remove = (): void => {
    if (!confirmed()) return;
    action.run(
      props.client.procedures.bucket.delete({
        rootToken: props.rootToken(),
        bucket: props.name,
      }),
      (gone) => `Deleted ${gone.name}: ${gone.objects} objects, ${bytes(gone.bytes)}.`,
    );
  };
  return (
    <Panel
      title="Delete this bucket"
      label="delete"
      actions={<DocsLink />}
    >
      <div class="panel-body">
        <div class="stack">
          <Field id="delete-confirm" label={`type ${props.name} to confirm`}>
            <TextInput
              id="delete-confirm"
              value={typed()}
              placeholder={props.name}
              onValue={setTyped}
            />
          </Field>
          <Button
            class="btn-danger"
            disabled={action.busy() || !confirmed()}
            onClick={remove}
          >
            {action.busy() ? "deleting…" : "Delete bucket"}
          </Button>
          <Answer control={action} />
        </div>
      </div>
    </Panel>
  );
}
