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
import { createEffect, createMemo, createSignal, For, on, Show, type JSX } from "solid-js";
import type { CacheBucket, CachePath, oduCacheSurface } from "./surface";

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
  // ── the list ──
  const buckets = props.client.collections.buckets.use();
  const rows = createMemo<CacheBucket[]>(() => {
    const out: CacheBucket[] = [];
    for (const key of buckets.keys()) {
      const row = buckets.byKey(key)?.();
      if (row !== undefined) out.push(row);
    }
    // By name, because a bucket list is a directory rather than a timeline.
    return out.sort((left, right) => left.name.localeCompare(right.name));
  });

  return (
    <Show when={props.bucket} fallback={<BucketList rows={rows()} now={props.now} onOpen={props.onOpen} />}>
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

function BucketList(props: {
  rows: CacheBucket[];
  now: number;
  onOpen: (bucket: string | null) => void;
}): JSX.Element {
  return (
    <section class="cache" aria-label="buckets">
      <h2>Buckets</h2>
      <Show
        when={props.rows.length > 0}
        fallback={
          <p class="hint">
            No buckets yet — <code>odu cache create &lt;bucket&gt;</code> makes one.
          </p>
        }
      >
        <ul class="buckets">
          <For each={props.rows}>
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

function BucketPage(props: {
  client: CacheClient;
  call: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  name: string;
  now: number;
  onOpen: (bucket: string | null) => void;
}): JSX.Element {
  const [filter, setFilter] = createSignal("");
  const [pages, setPages] = createSignal<CachePath[]>([]);
  const [next, setNext] = createSignal<string | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  /** One read of a page. `after` is the cursor the answer handed back, so a
   *  second page is a POSITION rather than an offset: a push landing between
   *  two reads shifts nothing the reader is about to see. */
  const read = (after: string | null, append: boolean): void => {
    setLoading(true);
    void props.call(
      props.client.procedures.bucket.paths({
        bucket: props.name,
        ...(filter() === "" ? {} : { filter: filter() }),
        ...(after === null ? {} : { after }),
      }),
    ).then(
      (answer) => {
        setLoading(false);
        setFailure(null);
        setPages(append ? [...pages(), ...answer.paths] : [...answer.paths]);
        setNext(answer.next ?? null);
      },
      (err: unknown) => {
        setLoading(false);
        setFailure(err instanceof Error ? err.message : String(err));
      },
    );
  };

  // A NEW BUCKET OR A NEW FILTER IS A NEW QUERY, from the first page. `on`
  // rather than a bare effect so the read does not run again on every unrelated
  // repaint of the page.
  createEffect(on(() => [props.name, filter()] as const, () => read(null, false)));

  /** The bucket's row, from the same subscription the list reads — so the key,
  *  the URL and the counts on this page move when the cache publishes them. */
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
                {row().lastPush === null ? "nothing pushed" : `pushed ${ago(row().lastPush ?? 0, props.now)}`}
              </span>
              <span>{row().hits} reads</span>
              <Show when={row().retentionDays > 0}>
                <span>{row().retentionDays}d retention</span>
              </Show>
            </p>
            {/* THE BLOCK A PERSON PASTES. `odu cache use` prints the same three
                things, and a page that printed them differently would be a
                second answer to "how do I use this bucket". */}
            <pre class="use-block">{`# nix.conf
extra-substituters = ${row().url}
extra-trusted-public-keys = ${row().publicKey}

# netrc — Nix reads only the file named by netrc-file, never ~/.netrc
netrc-file = ~/.netrc
machine ${hostOf(row().url)} password <your-write-token>`}</pre>
          </>
        )}
      </Show>

      <div class="cache-paths">
        <label class="search">
          <span class="sr-only">filter paths</span>
          <input
            type="search"
            placeholder="filter by path, e.g. openssl"
            value={filter()}
            onInput={(event) => setFilter(event.currentTarget.value)}
          />
        </label>
        <Show when={failure()}>{(message) => <p class="refused">{message()}</p>}</Show>
        <Show
          when={pages().length > 0}
          fallback={
            <p class="hint">
              {loading() ? "reading…" : filter() === "" ? "Nothing pushed to this bucket yet." : "No path matches that filter."}
            </p>
          }
        >
          <ol class="paths">
            <For each={pages()}>
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
            <button type="button" class="link" disabled={loading()} onClick={() => read(after(), true)}>
              {loading() ? "reading…" : `more (${PAGE} newer first)`}
            </button>
          )}
        </Show>
      </div>
    </section>
  );
}

/** The authority of a substituter URL, for the netrc line. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
