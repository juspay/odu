import type { Effect } from "effect";
import {
  type Accessor,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import { refusalText } from "@odu/face/refusal";
import { type CacheClient, keepIdentity, type PathColumn, type PathRow, pathRows } from "./face";
import type { CachePath } from "./surface";

const FILTER_DEBOUNCE_MS = 200;

export type Versions =
  | { readonly kind: "reading" }
  | {
      readonly kind: "held";
      readonly versions: readonly CachePath[];
      readonly next: string | null;
      readonly reading: boolean;
    }
  | { readonly kind: "failed"; readonly message: string };

type FirstPage =
  | {
      readonly ok: true;
      readonly rows: readonly PathRow[];
      readonly next: string | null;
      readonly retentionDays: number;
    }
  | { readonly ok: false; readonly message: string };

interface AppendedPages {
  readonly rows: readonly PathRow[];
  readonly next: string | null;
}

interface OpenVersions {
  readonly key: string;
  readonly open: ReadonlySet<string>;
  readonly byName: ReadonlyMap<string, Versions>;
}

export interface PathsQuery {
  typed: Accessor<string>;
  setTyped: (v: string) => void;
  filter: Accessor<string>;
  grouped: Accessor<boolean>;
  setGrouped: (v: boolean) => void;
  column: Accessor<PathColumn>;
  descending: Accessor<boolean>;
  sortBy: (which: PathColumn) => void;
  rows: Accessor<readonly PathRow[]>;
  next: Accessor<string | null>;
  refusal: Accessor<string | null>;
  failure: Accessor<string | null>;
  loading: Accessor<boolean>;
  loadingMore: Accessor<boolean>;
  answeredRetention: Accessor<number>;
  more: (after: string) => void;
  refetch: () => void;
  refresh: () => void;
  isOpen: (name: string) => boolean;
  toggleOpen: (name: string) => void;
  readVersions: (name: string, after: string | null) => void;
  openState: (name: string) => Versions | undefined;
}

export function pathsQuery(input: {
  client: CacheClient;
  call: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  bucket: Accessor<string>;
  retentionDays: Accessor<number>;
}): PathsQuery {
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
      input.bucket,
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

  const retention = createMemo(() => input.retentionDays());

  const [first, { refetch }] = createResource(
    () => ({ asked: { bucket: input.bucket(), ...query() }, retentionDays: retention() }),
    async ({ asked, retentionDays }): Promise<FirstPage> => {
      setAppended(null);
      setFailure(null);
      setLoadingMore(false);
      supersede();
      try {
        const page = await input.call(input.client.procedures.bucket.paths(asked));
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
    void input
      .call(input.client.procedures.bucket.paths({ bucket: input.bucket(), ...query(), after }))
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

  const key = (): string => `${input.bucket()}\u0000${filter()}\u0000${retention()}`;
  const fresh = (): OpenVersions => ({ key: key(), open: new Set(), byName: new Map() });
  const [store, setStore] = createSignal<OpenVersions>(fresh());
  const standing = (): OpenVersions => {
    const been = store();
    return been.key === key() ? been : fresh();
  };
  const held = (name: string, state: Versions): void => {
    setStore(() => {
      const base = standing();
      return { key: base.key, open: base.open, byName: new Map(base.byName).set(name, state) };
    });
  };
  const openState = (name: string): Versions | undefined => {
    const been = standing();
    return been.open.has(name) ? been.byName.get(name) : undefined;
  };
  const isOpen = (name: string): boolean => standing().open.has(name);

  const readVersions = (name: string, after: string | null): void => {
    const asked = current();
    const been = standing().byName.get(name);
    held(
      name,
      after === null || been?.kind !== "held" ? { kind: "reading" } : { ...been, reading: true },
    );
    void input
      .call(
        input.client.procedures.bucket.paths({
          bucket: input.bucket(),
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
          const drawn = standing().byName.get(name);
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
    const been = standing();
    const open = !been.open.has(name);
    const opened = new Set(been.open);
    if (open) opened.add(name);
    else opened.delete(name);
    setStore({ key: been.key, open: opened, byName: been.byName });
    if (!open || been.byName.has(name)) return;
    readVersions(name, null);
  };

  return {
    typed,
    setTyped: (v) => void setTyped(v),
    filter,
    grouped,
    setGrouped: (v) => void setGrouped(v),
    column,
    descending,
    sortBy,
    rows,
    next,
    refusal,
    failure,
    loading: () => first.loading,
    loadingMore,
    answeredRetention,
    more,
    refetch: () => void refetch(),
    refresh: () => {
      setStore(fresh());
      void refetch();
    },
    isOpen,
    toggleOpen,
    readVersions,
    openState,
  };
}
