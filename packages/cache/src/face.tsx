/**
 * THE CACHE VIEW — the board's second row, and the cache's own face.
 *
 * It is here rather than in `@odu/web-ui` for the reason `@odu/cache` exists: a
 * row owns everything about itself, and what a bucket LOOKS like is one of
 * those things. The board imports this and hands it a client; it holds no run
 * client, reaches no other row's members, and could be dropped onto any page
 * that serves the cache surface.
 *
 * ## Two screens, one address
 *
 * `#/cache` lists the buckets; `#/cache/<name>` is one bucket. The address is
 * the ROUTE's, not a signal's, so Back works through them and a person can send
 * somebody a link to a bucket — the same rule the run view keeps.
 *
 * ## What a bucket page answers
 *
 * The three facts a client needs and nothing else: the substituter URL, the
 * public key, and the block `odu cache use` prints — as text a person copies,
 * which is why it is a `<pre>` rather than three labelled fields. Then the
 * bucket's PATHS, newest first, with the filter box narrowing them: the
 * question "did my build actually land" is asked by scrolling, and asked again
 * by typing a derivation's name.
 *
 * ## The one thing it does not do
 *
 * It never reads a bucket through a token-gated verb. `bucket.paths` and
 * `bucket.describe` take none, which is the cache's own decision — a bucket's
 * URL, key and path list are what the substituter publishes to anyone who can
 * read it — so a view can ask them without holding an operator's secret.
 */

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
  type JSX,
} from "solid-js";
import {
  type CacheBucket,
  type CachePath,
  oduCacheSurface,
  PATH_PAGE_SIZE,
  useBlock,
} from "./surface";

type CacheSpec = (typeof oduCacheSurface)["spec"];

/** The cache's client as a VIEW holds it — exported so a shell can type the
 *  prop it threads down without naming the surface framework itself. */
export type CacheClient = SurfaceClient<CacheSpec>;

export interface CacheFaceProps {
  /** THE CACHE CLIENT AND NOTHING ELSE — the property this file's placement is
   *  for. A view with the runs' client would be a view that could start one. */
  client: CacheClient;
  /** The bucket the route names, or `null` for the list. */
  bucket: string | null;
  /** Move the route: `null` closes the bucket. */
  onOpen: (bucket: string | null) => void;
  /** One clock for the page, read once a second by the shell. */
  now: number;
  /** THE UI EDGE, supplied by the shell rather than taken here.
   *
   *  A procedure is an `Effect` — a description — and a click is the moment one
   *  becomes execution. That crossing is the PAGE's (`@odu/web-ui`'s `app.tsx`,
   *  which is the browser's one `Effect.runPromise`), so a view of this row
   *  hands it the description and never runs one itself: two edges in one
   *  bundle would be two answers to what a refusal means. */
  call: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
}

/** How many paths one page carries. The contract's own page size, repeated here
 *  because the view has to know when to offer "more". */
const PAGE = 100;

/** Bytes as a person reads them — binary units, because a store is. */
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

/** How long ago, in the words a board uses for a run's age. */
function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function CacheFace(props: CacheFaceProps): JSX.Element {
  return (
    <Show when={props.bucket} fallback={<BucketList client={props.client} now={props.now} onOpen={props.onOpen} />}>
      {(name) => (
        <BucketPage
          client={props.client}
          call={props.call}
          name={name()}
          now={props.now}
          onOpen={props.onOpen}
        />
      )}
    </Show>
  );
}

/**
 * ROWS THAT KEEP THEIR IDENTITY ACROSS A PUBLISH.
 *
 * `<For>` keys by the row VALUE, so a publish that re-creates every row object
 * disposes and re-inserts every row — and the button a person was tabbing to,
 * or had focused, is gone. So a row whose facts did not change is handed back as
 * the SAME object: the cache publishes a bundle's counters every second, and a
 * keyboard user should not pay for it.
 */
function keepIdentity<T extends { readonly name: string }>(): (row: T) => T {
  const held = new Map<string, { readonly row: T; readonly encoded: string }>();
  return (row) => {
    const encoded = JSON.stringify(row);
    const seen = held.get(row.name);
    if (seen !== undefined && seen.encoded === encoded) return seen.row;
    held.set(row.name, { row, encoded });
    return row;
  };
}

function BucketList(props: {
  client: CacheClient;
  now: number;
  onOpen: (bucket: string | null) => void;
}): JSX.Element {
  const held = props.client.collections.buckets.use();
  const stable = keepIdentity<CacheBucket>();
  const rows = createMemo<CacheBucket[]>(() => {
    const out: CacheBucket[] = [];
    for (const key of held.keys()) {
      const row = held.byKey(key)?.();
      if (row !== undefined) out.push(stable(row));
    }
    // By name, because a bucket list is a directory rather than a timeline.
    return out.sort((left, right) => left.name.localeCompare(right.name));
  });
  return (
    <section class="cache" aria-label="buckets">
      <h2>Buckets</h2>
      <Show
        when={rows().length > 0}
        fallback={
          <p class="hint">
            No buckets yet — <code>odu cache create &lt;bucket&gt;</code> makes one.
          </p>
        }
      >
        <ul class="buckets">
          <For each={rows()}>
            {(bucket) => (
              <li>
                {/* A real button: reachable by Tab, fired by Enter and Space,
                    announced as a control. The row IS the link. */}
                <button type="button" class="bucket" onClick={() => props.onOpen(bucket.name)}>
                  <span class="bucket-name">
                    {bucket.name}
                    <Show when={!bucket.public}>
                      <span class="pill">private</span>
                    </Show>
                  </span>
                  <span class="bucket-facts">
                    <span>{bucket.objects} paths</span>
                    <span>{bytes(bucket.bytes)}</span>
                    <span>
                      {bucket.lastPush === null
                        ? "nothing pushed"
                        : `pushed ${ago(bucket.lastPush, props.now)}`}
                    </span>
                    <span>{bucket.hits} reads</span>
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

/** How long the filter waits for the typing to stop before it asks. Short
 *  enough that a pause reads as an answer, long enough that a word typed at
 *  speed is one query rather than six. */
const FILTER_DEBOUNCE_MS = 200;

function BucketPage(props: {
  client: CacheClient;
  call: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  name: string;
  now: number;
  onOpen: (bucket: string | null) => void;
}): JSX.Element {
  /** What the person typed, and what the query is allowed to see. Two signals:
   *  the box must track every keystroke, and the request must not. */
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

  /** A "more" page, appended to the first. Cleared whenever the QUERY changes,
   *  because a cursor belongs to the filter that minted it. */
  const [appended, setAppended] = createSignal<CachePath[]>([]);
  const [extra, setExtra] = createSignal<string | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [loadingMore, setLoadingMore] = createSignal(false);

  /**
   * THE FIRST PAGE, AS A RESOURCE KEYED ON `[name, filter]`.
   *
   * `createResource` is what makes the filter safe: a keystroke supersedes the
   * read before it, and a superseded answer is DISCARDED rather than painted
   * over a newer one — which is what a bare promise chain did, in whatever order
   * the answers happened to arrive. Its `onCleanup` is the resource's own, so a
   * page that navigates away mid-read leaves nothing running.
   */
  const [first] = createResource(
    () => [props.name, filter()] as const,
    async ([name, needle]) => {
      setAppended([]);
      setExtra(null);
      setFailure(null);
      return props.call(
        props.client.procedures.bucket.paths({
          bucket: name,
          ...(needle === "" ? {} : { filter: needle }),
        }),
      );
    },
  );

  /** A later page. Not a resource: it is a click, and it appends to what the
   *  resource already answered for the SAME query. */
  const more = (after: string): void => {
    setLoadingMore(true);
    void props
      .call(
        props.client.procedures.bucket.paths({
          bucket: props.name,
          ...(filter() === "" ? {} : { filter: filter() }),
          after,
        }),
      )
      .then(
        (answer) => {
          setLoadingMore(false);
          setAppended([...appended(), ...answer.paths]);
          setExtra(answer.next ?? null);
        },
        (err: unknown) => {
          setLoadingMore(false);
          setFailure(err instanceof Error ? err.message : String(err));
        },
      );
  };

  const stable = keepIdentity<CachePath & { readonly name: string }>();
  const paths = createMemo<Array<CachePath & { readonly name: string }>>(() =>
    [...(first()?.paths ?? []), ...appended()].map((path) =>
      stable({ ...path, name: path.storePath }),
    ),
  );
  const next = createMemo<string | null>(() => extra() ?? first()?.next ?? null);

  /** The bucket's row, from the same subscription the list reads. */
  const held = props.client.collections.buckets.use();
  const bucket = createMemo<CacheBucket | undefined>(() => held.byKey(props.name)?.());

  return (
    <section class="cache" aria-label={`bucket ${props.name}`}>
      <p class="crumbs">
        <button type="button" class="link" onClick={() => props.onOpen(null)}>
          ← buckets
        </button>
      </p>
      <h2>
        {props.name}
        <Show when={bucket() !== undefined && !bucket()!.public}>
          <span class="pill">private</span>
        </Show>
      </h2>
      <Show when={bucket()} fallback={<p class="hint">This bucket is not on the board — it may have been removed.</p>}>
        {(row) => (
          <>
            <p class="bucket-facts">
              <span>{row().objects} paths</span>
              <span>{bytes(row().bytes)}</span>
              <span>
                {row().lastPush === null
                  ? "nothing pushed"
                  : `pushed ${ago(row().lastPush ?? 0, props.now)}`}
              </span>
              <span>{row().hits} reads</span>
              <Show when={row().retentionDays > 0}>
                <span>{row().retentionDays}d retention</span>
              </Show>
            </p>
            {/* THE BLOCK A PERSON PASTES, from the same function `odu cache use`
                prints it with — the page cannot know a home directory, so it
                names `~`. */}
            <pre class="use-block">
              {useBlock({ url: row().url, publicKey: row().publicKey, home: "~" })}
            </pre>
          </>
        )}
      </Show>

      <div class="cache-paths">
        <label class="search">
          <span class="sr-only">filter paths</span>
          <input
            type="search"
            placeholder="filter by path, e.g. openssl"
            value={typed()}
            onInput={(event) => setTyped(event.currentTarget.value)}
          />
        </label>
        <Show when={failure()}>{(message) => <p class="refused">{message()}</p>}</Show>
        <Show
          when={paths().length > 0}
          fallback={
            <p class="hint">
              {first.loading
                ? "reading…"
                : filter() === ""
                  ? "Nothing pushed to this bucket yet."
                  : "No path matches that filter."}
            </p>
          }
        >
          <ol class="paths">
            <For each={paths()}>
              {(path) => (
                <li>
                  <code class="path">{path.storePath}</code>
                  <span class="bucket-facts">
                    <span>{bytes(path.narSize)}</span>
                    <span>{ago(path.created, props.now)}</span>
                    <span>{path.hits} reads</span>
                  </span>
                </li>
              )}
            </For>
          </ol>
        </Show>
        <Show when={next()}>
          {(after) => (
            <button
              type="button"
              class="link"
              disabled={loadingMore() || first.loading}
              onClick={() => more(after())}
            >
              {loadingMore() ? "reading…" : `more (${PATH_PAGE_SIZE} newer first)`}
            </button>
          )}
        </Show>
      </div>
    </section>
  );
}
