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
 * ## Reading needs no secret; administering is the row's floor
 *
 * The READS never go through a gated verb. `bucket.paths` and
 * `bucket.describe` take none, which is the cache's own decision — a bucket's
 * URL, key and path list are what the substituter publishes to anyone who can
 * read it — so a member's view asks them without holding anything.
 *
 * Every OTHER verb of the row has a control here too, because the board does
 * everything `odu cache` does: create (with the upstream switch), and per
 * bucket mint / list / revoke a token, pin a closure, run GC, read stats. They
 * are DRAWN for the row's floor (the shell's `canAdminister`) and REFUSED by
 * the row on its own — never one check standing in for the other.
 */

import { createControl, type Control } from "@odu/face/control";
import { ago, bytes } from "@odu/cordis/format";
import { refusalText } from "@odu/face/refusal";
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
  type CacheStats,
  type CacheToken,
  oduCacheSurface,
  PATH_PAGE_SIZE,
  pushBlock,
  useBlock,
  useCommand,
  type CacheScope,
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
  /** MAY THIS PERSON ADMINISTER BUCKETS? The ROW's floor is `admin`, and the
   *  shell reads it off the connection's principal — the face DRAWS what the
   *  role can use and hides the rest. The row REFUSES on its own (`not_permitted`,
   *  `no_root_token`): two independent checks, because a hidden button is not a
   *  permission and a drawn one is not a grant. */
  canAdminister: boolean;
  /** DOES THE SHELL MOUNT THE TUNNEL ROW? With it, a bucket's name is routed
   *  by that row and the page must not tell the operator to make the record;
   *  without it, pointing the record is exactly the operator's next step. */
  tunnelRow: boolean;
  /** IS THIS PERSON THE DAEMON'S LOCAL OWNER — a daemon with no door? Then the
   *  row's rule for administration is the operator's ROOT TOKEN rather than a
   *  role, so the page asks for it once (the same secret `odu cache` reads from
   *  `$ODU_ROOT_TOKEN`), and an empty list points at the CLI as it always has. */
  local: boolean;
  /** THE UI EDGE, supplied by the shell rather than taken here.
   *
   *  A procedure is an `Effect` — a description — and a click is the moment one
   *  becomes execution. That crossing is the PAGE's (`@odu/web-ui`'s `app.tsx`,
   *  which is the browser's one `Effect.runPromise`), so a view of this row
   *  hands it the description and never runs one itself: two edges in one
   *  bundle would be two answers to what a refusal means. */
  call: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
}

/** What every administrative control needs beside its own fields: the client,
 *  the UI edge, and the credential the row compares for a local owner. */
interface AdminProps {
  client: CacheClient;
  call: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  /** `""` for a signed-in person — the row ignores it, their role is the
   *  authority — and what the local owner typed otherwise. */
  rootToken: () => string;
}

export function CacheFace(props: CacheFaceProps): JSX.Element {
  // THE PAGE'S ONE COPY OF THE ROOT TOKEN, for as long as the cache is on
  // screen and no longer: a signal owned by this face, never written to storage,
  // and gone when the shell switches rows.
  const [rootToken, setRootToken] = createSignal("");
  const admin: AdminProps = {
    get client() {
      return props.client;
    },
    get call() {
      return props.call;
    },
    rootToken: () => (props.local ? rootToken() : ""),
  };
  return (
    <>
      <Show when={props.local && props.canAdminister}>
        <label class="search root-token">
          <span class="sr-only">root token</span>
          <input
            type="password"
            class="input"
            autocomplete="off"
            placeholder="root token ($ODU_ROOT_TOKEN) — what this daemon's administration checks"
            value={rootToken()}
            onInput={(event) => setRootToken(event.currentTarget.value)}
          />
        </label>
      </Show>
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
            tunnelRow={props.tunnelRow}
          />
        )}
      </Show>
    </>
  );
}

/** WHY THE UPSTREAM SWITCH EXISTS, in the docs' one line: a store that did not
 *  build the paths never holds nixpkgs, so a bucket that skips upstream paths
 *  makes every push wait at 202 for referrers that will never arrive. */
export const UPSTREAM_HINT =
  "Skip paths cache.nixos.org already signed. Turn off for a server whose " +
  "store is not the machine that built the paths, or every push waits at 202 " +
  "(the CLI's --no-upstream).";

/**
 * CREATE A BUCKET.
 *
 * A name, and the creation facts a deployment needs — the upstream switch, on
 * by default, and WHERE its objects live when this daemon declared more than
 * its own disk — beside the two it is created with (public, ninety days of
 * retention). The stores are the row's `stores` cell, drawn as the row names
 * them: the face spells no store, not even the default, which is whatever the
 * row does when none is sent. The button is ENABLED whenever this control is drawn: the name
 * is sent as typed, empty included, and the ROW's refusal is what the person
 * reads — one rule, in one place, rather than a face's copy of it.
 */
function CreateBucket(
  props: AdminProps & { onCreated: (bucket: string | null) => void },
): JSX.Element {
  const [name, setName] = createSignal("");
  const [upstream, setUpstream] = createSignal(true);
  /** The stores this daemon declared; one store is no choice, so no control. */
  const stores = props.client.cells.stores.use();
  const offered = createMemo(() => stores.value() ?? []);
  /** `null` until the person picks one: the row's own default then applies. */
  const [store, setStore] = createSignal<string | null>(null);
  const control = createControl(props.call);
  const create = (): void => {
    control.run(
      props.client.procedures.bucket.create({
        // The row ignores this for a signed-in admin (its role authorises the
        // call); only a local owner's token is compared.
        rootToken: props.rootToken(),
        name: name().trim(),
        public: true,
        retentionDays: 90,
        // ON is the row's own default (nixpkgs' key), so it is left ABSENT;
        // OFF is the empty list, exactly what `--no-upstream` sends.
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
  return (
    <div class="cache-create">
      <label class="search">
        <span class="sr-only">new bucket name</span>
        <input
          type="text"
          class="input"
          placeholder="new bucket name"
          value={name()}
          onInput={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <label class="toggle">
        <input
          type="checkbox"
          checked={upstream()}
          onChange={(event) => setUpstream(event.currentTarget.checked)}
        />
        Skip upstream paths
      </label>
      <p class="hint">{UPSTREAM_HINT}</p>
      <Show when={offered().length > 1}>
        <label class="field-inline">
          <span>store</span>
          <select
            class="input"
            aria-label="bucket store"
            value={store() ?? offered()[0]?.name ?? ""}
            onChange={(event) => setStore(event.currentTarget.value)}
          >
            <For each={offered()}>
              {(one) => (
                <option value={one.name}>
                  {one.name} — {one.kind === "local" ? "this server's disk" : "S3"}
                </option>
              )}
            </For>
          </select>
        </label>
      </Show>
      <button type="button" class="btn btn-primary" disabled={control.busy()} onClick={create}>
        {control.busy() ? "creating…" : "Create bucket"}
      </button>
      <Answer control={control} />
    </div>
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

/**
 * WHAT AN EMPTY CACHE SAYS, to whoever is looking — the one sentence that
 * depends on the person rather than on the data. Exported and pure so the three
 * answers are pinned by a unit test rather than by reading JSX.
 */
export function emptyBucketsText(viewer: { canAdminister: boolean; local: boolean }): string {
  // No door: the person at this machine owns it, and the CLI is how they have
  // always done it — the form above works too, with the root token.
  if (viewer.local) {
    return "No buckets yet — odu cache create <bucket> makes one, or use the form above.";
  }
  if (viewer.canAdminister) return "No buckets yet — name one in the form above to create it.";
  return "There are no buckets yet.";
}

function BucketList(
  props: AdminProps & {
    now: number;
    onOpen: (bucket: string | null) => void;
    canAdminister: boolean;
    local: boolean;
  },
): JSX.Element {
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
      {/* The ROW's floor made visible: creating a bucket needs an `admin`, so a
          member is not shown a form whose call would be refused. */}
      <Show when={props.canAdminister}>
        <CreateBucket
          client={props.client}
          call={props.call}
          rootToken={props.rootToken}
          onCreated={props.onOpen}
        />
      </Show>
      <Show
        when={rows().length > 0}
        fallback={
          <p class="hint">
            {emptyBucketsText({ canAdminister: props.canAdminister, local: props.local })}
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
                      <span class="pill hue-grey">private</span>
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

/** What a read of one bucket answered: the page, or the sentence explaining why
 *  there is none. A refusal is an ANSWER (`CacheRefused` is a typed failure),
 *  not an outage, so it travels as the value rather than as a resource error. */
type FirstPage =
  | {
      readonly ok: true;
      readonly page: { readonly paths: readonly CachePath[]; readonly next?: string };
    }
  | { readonly ok: false; readonly message: string };

/** How long the filter waits for the typing to stop before it asks. Short
 *  enough that a pause reads as an answer, long enough that a word typed at
 *  speed is one query rather than six. */
const FILTER_DEBOUNCE_MS = 200;

function BucketPage(
  props: AdminProps & {
    name: string;
    now: number;
    onOpen: (bucket: string | null) => void;
    canAdminister: boolean;
    tunnelRow: boolean;
  },
): JSX.Element {
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
  // A FILTER IS ABOUT ONE BUCKET. Opening another one starts with an empty box
  // and an empty query, or the second bucket is read through the first one's
  // words and shows nothing.
  createEffect(
    on(
      () => props.name,
      () => {
        if (pending !== undefined) clearTimeout(pending);
        setTyped("");
        setFilter("");
      },
      { defer: true },
    ),
  );

  /** A "more" page, appended to the first. Cleared whenever the QUERY changes,
   *  because a cursor belongs to the filter that minted it. */
  const [appended, setAppended] = createSignal<CachePath[]>([]);
  const [extra, setExtra] = createSignal<string | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);
  const [loadingMore, setLoadingMore] = createSignal(false);

  /**
   * EVERY READ CARRIES THE QUERY IT BELONGS TO.
   *
   * A keystroke supersedes the read before it, and a "more" page is a click on
   * a list that a keystroke can replace while the page is in flight. So each
   * read tags itself with a GENERATION, and an answer whose generation is no
   * longer current is DROPPED rather than painted into a list it does not
   * describe. `onCleanup` retires the page's generation on unmount, so a read
   * that lands after the page is gone writes nothing at all.
   */
  let generation = 0;
  const current = (): number => generation;
  const supersede = (): number => {
    generation += 1;
    return generation;
  };
  onCleanup(() => {
    supersede();
  });

  /**
   * THE FIRST PAGE, AS A RESOURCE KEYED ON `[name, filter]`.
   *
   * `createResource` is what makes the filter safe: a keystroke supersedes the
   * read before it, and a superseded answer is DISCARDED rather than painted
   * over a newer one — which is what a bare promise chain did, in whatever order
   * the answers happened to arrive. Its `onCleanup` is the resource's own, so a
   * page that navigates away mid-read leaves nothing running.
   *
   * THE ANSWER IS A VALUE, REFUSALS INCLUDED. A resource whose fetch REJECTS
   * holds the error in `error`, and `read()` rethrows it at whoever touches the
   * value — so every reader would have to remember not to. Worse, a rejected
   * fetch on this page left the resource pending and the rejection unhandled:
   * the refusal then rendered as "reading…" forever, which is precisely the
   * page-not-error confusion this screen exists to avoid. A refusal here is
   * not an outage to retry into the void; it is a sentence somebody reads, so
   * it comes back as the value like every other answer.
   */
  const [first, { refetch }] = createResource(
    () => [props.name, filter()] as const,
    async ([name, needle]): Promise<FirstPage> => {
      setAppended([]);
      setExtra(null);
      setFailure(null);
      setLoadingMore(false);
      // A NEW QUERY RETIRES EVERY PAGE READ AGAINST THE OLD ONE.
      supersede();
      try {
        return {
          ok: true,
          page: await props.call(
            props.client.procedures.bucket.paths({
              bucket: name,
              ...(needle === "" ? {} : { filter: needle }),
            }),
          ),
        };
      } catch (err) {
        return { ok: false, message: refusalText(err) };
      }
    },
  );

  /** A later page. Not a resource: it is a click, and it appends to what the
   *  resource already answered for the SAME query — which is exactly why it
   *  carries the generation it was asked under. */
  const more = (after: string): void => {
    const asked = current();
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
          if (asked !== current()) return; // the query moved on
          setLoadingMore(false);
          setAppended([...appended(), ...answer.paths]);
          setExtra(answer.next ?? null);
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

  const stable = keepIdentity<CachePath & { readonly name: string }>();
  const paths = createMemo<Array<CachePath & { readonly name: string }>>(() => {
    const answer = first();
    if (answer === undefined || !answer.ok) return [];
    return [...answer.page.paths, ...appended()].map((path) =>
      stable({ ...path, name: path.storePath }),
    );
  });
  const next = createMemo<string | null>(() => {
    const answer = first();
    if (extra() !== null) return extra();
    return answer !== undefined && answer.ok ? (answer.page.next ?? null) : null;
  });

  /** THE TOKEN JUST MINTED HERE, held by the page so the push block can show
   *  it in its one showing. It belongs to ONE bucket: opening another clears
   *  it rather than printing this bucket's secret under that one's name. */
  const [minted, setMinted] = createSignal<Minted | null>(null);
  createEffect(on(() => props.name, () => setMinted(null), { defer: true }));

  /** The bucket's row, from the same subscription the list reads. */
  const buckets = props.client.collections.buckets.use();
  const bucket = createMemo<CacheBucket | undefined>(() => buckets.byKey(props.name)?.());

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
          <span class="pill hue-grey">private</span>
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
              {/* WHERE THE BYTES ARE: the store it was created on. */}
              <span class="bucket-store">objects on {row().store}</span>
              {/* The creation fact the upstream switch set, said back: a
                  bucket that takes every path is a choice worth seeing. */}
              <span>
                {row().upstreamKeys.length === 0
                  ? "no upstream filter"
                  : `skips ${row().upstreamKeys.join(", ")}`}
              </span>
            </p>
            {/* HOW TO USE THIS BUCKET, in two blocks a person copies: reading
                from it, and pushing to it. Both come from the contract's own
                functions — `odu cache use` prints the first, and the docs quote
                the second — so the page, the terminal and the docs cannot say
                three different things. */}
            <h3>Use it</h3>
            <p class="hint">
              The lines for a Nix client — or let a terminal print them:{" "}
              <code>{useCommand(props.name)}</code>
            </p>
            <pre class="use-block consume-block">
              {useBlock({ url: row().url, publicKey: row().publicKey, home: null })}
            </pre>
            <h3>Push to it</h3>
            <p class="hint">
              {minted()?.scope === "write"
                ? "With the write token you just minted — paste it into your build's secrets now; it is not shown again."
                : props.canAdminister
                  ? "Mint a write token below, and this block fills it in while it can be shown."
                  : "With a write token an admin of this server mints for you."}{" "}
              A ready-made GitHub Actions step is planned.
            </p>
            <pre class="use-block push-block">
              {pushBlock({
                origin: (() => {
                  try {
                    return new URL(row().pushUrl).origin;
                  } catch {
                    return row().pushUrl;
                  }
                })(),
                bucket: props.name,
                token: minted()?.scope === "write" ? (minted()?.token ?? null) : null,
              })}
            </pre>
          </>
        )}
      </Show>

      {/* THE BUCKET'S ADMINISTRATION, drawn for the row's floor and KEYED on
          the name: a minted token, a pin's fields and a GC report belong to ONE
          bucket, so opening another one builds these afresh rather than
          carrying a secret across. */}
      <Show when={props.canAdminister && bucket() !== undefined ? props.name : null} keyed>
        {(name) => (
          <>
            <BucketDomain
              client={props.client}
              call={props.call}
              rootToken={props.rootToken}
              name={name}
              domain={bucket()?.domain ?? null}
              tunnelRow={props.tunnelRow}
            />
            <BucketAdmin
              client={props.client}
              call={props.call}
              rootToken={props.rootToken}
              minted={minted()}
              onMinted={setMinted}
              name={name}
              now={props.now}
            />
          </>
        )}
      </Show>

      <div class="cache-paths">
        <label class="search">
          <span class="sr-only">filter paths</span>
          <input
            type="search"
            class="input"
            placeholder="filter by path, e.g. openssl"
            value={typed()}
            onInput={(event) => setTyped(event.currentTarget.value)}
          />
        </label>
        {/* THE FIRST PAGE'S OWN REFUSAL, from the resource's VALUE — see the
            fetcher: a rejection would be an unhandled one. */}
        <Show when={refusal()}>{(message) => <p class="fault">{message()}</p>}</Show>
        <Show when={failure()}>{(message) => <p class="fault">{message()}</p>}</Show>
        <Show when={refusal() !== null || failure() !== null}>
          <button type="button" class="text-action" onClick={() => refetch()}>
            try again
          </button>
        </Show>
        <Show
          when={paths().length > 0}
          fallback={
            <Show when={refusal() === null && failure() === null}>
              <p class="hint">
                {first.loading
                  ? "reading…"
                  : filter() === ""
                    ? "Nothing pushed to this bucket yet."
                    : "No path matches that filter."}
              </p>
            </Show>
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
              class="text-action"
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

// ── a bucket's administration ───────────────────────────────────────────────

/** What a control answered, drawn the one way every answer on this page is. */
function Answer(props: { control: Control }): JSX.Element {
  return (
    <>
      <Show when={props.control.fault()}>{(message) => <p class="fault">{message()}</p>}</Show>
      <Show when={props.control.done()}>{(message) => <p class="hint done">{message()}</p>}</Show>
    </>
  );
}

/** A read that answers a value OR the sentence explaining why there is none —
 *  the same rule {@link FirstPage} keeps, for the same reason. */
type Reading<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** How a token's life reads, in one phrase. */
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

/**
 * EVERYTHING AN ADMIN DOES TO ONE BUCKET without a terminal — the verbs
 * `odu cache token|pin|gc|stats` call, as four sections.
 *
 * Drawn only for the row's floor (the shell's decision) and refused by the row
 * on its own; each section reads or writes through the shell's edge and owns
 * its answers, so a refusal in one is not painted over another.
 */
/** A token minted on this page, while its plaintext can still be shown. */
interface Minted {
  readonly id: string;
  readonly token: string;
  readonly scope: CacheScope;
}

type TokenProps = AdminProps & {
  name: string;
  now: number;
  /** Held by the PAGE, so the push block above can fill it in. */
  minted: Minted | null;
  onMinted: (minted: Minted | null) => void;
};

function BucketAdmin(props: TokenProps): JSX.Element {
  return (
    <div class="bucket-admin">
      <BucketTokens {...props} />
      <BucketPin {...props} />
      <BucketGc {...props} />
      <BucketStats {...props} />
    </div>
  );
}

/**
 * THE NAME A BUCKET IS SERVED AT — a domain, or a path under the origin.
 *
 * A NAME BELONGS TO THE BUCKET, not to the page: setting it changes the
 * substituted URL, the `nix.conf` block above and the push's address. WHO
 * creates the DNS record is the deployment's: with a tunnel row mounted, the
 * row does and the strip beside this page carries its state; without one, the
 * operator points the record, and the answer says so.
 */
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
            // THE RECORD IS THE TUNNEL ROW'S JOB. Its state is on the strip
            // beside this page (wiring / live / failed: reason); claiming a
            // manual step here would be the stale instruction this replaced.
            ? `Named this bucket ${row.domain}. The tunnel row is wiring its route.`
            : `Named this bucket ${row.domain}. Point its DNS record here.`,
    );
  };
  return (
    <section class="admin-section" aria-label="domain">
      <h3>A name of its own</h3>
      <p class="hint">
        A DNS name for this bucket, with no scheme and no port. When it is set,
        the substituter URL, the netrc block and the push block use it. The
        NixOS module needs a virtual host for the same name; a bucket on the
        public pod gets one through a tunnel row.
      </p>
      <label class="search">
        <span class="sr-only">bucket domain</span>
        <input
          type="text"
          class="input"
          placeholder="cache.example.org"
          value={typed()}
          onInput={(event) => setTyped(event.currentTarget.value)}
        />
      </label>
      <div class="cache-create">
        <button
          type="button"
          class="btn btn-primary"
          disabled={action.busy()}
          onClick={() => apply(typed().trim())}
        >
          {action.busy() ? "working…" : "Set domain"}
        </button>
        <Show when={props.domain !== null}>
          <button
            type="button"
            class="btn"
            disabled={action.busy()}
            onClick={() => apply(null)}
          >
            Clear domain
          </button>
        </Show>
      </div>
      <Answer control={action} />
    </section>
  );
}

/** `token.mint`, `token.list`, `token.revoke` for this bucket. */
function BucketTokens(props: TokenProps): JSX.Element {
  const [scope, setScope] = createSignal<"write" | "read">("write");
  // AN EXPIRY IS THE FORM'S DEFAULT, not the row's: a token minted at a
  // terminal with no `--expires-days` does not expire, and a page must not
  // silently do what no visible field said. Ninety days is the default the
  // select shows; "never" is a choice a person makes.
  const [expiry, setExpiry] = createSignal("90");
  const minted = (): Minted | null => props.minted;
  const setMinted = props.onMinted;
  const action = createControl(props.call);

  const [tokens, { refetch }] = createResource(
    () => props.name,
    async (bucket): Promise<Reading<readonly CacheToken[]>> => {
      try {
        const answer = await props.call(
          props.client.procedures.token.list({ rootToken: props.rootToken(), bucket }),
        );
        return { ok: true, value: answer.tokens };
      } catch (err) {
        return { ok: false, message: refusalText(err) };
      }
    },
  );
  const listed = createMemo<readonly CacheToken[]>(() => {
    const answer = tokens();
    return answer !== undefined && answer.ok ? answer.value : [];
  });
  const listFault = createMemo<string | null>(() => {
    const answer = tokens();
    return answer === undefined || answer.ok ? null : answer.message;
  });

  const mint = (): void => {
    const chosen = scope();
    action.run(
      props.client.procedures.token.mint({
        rootToken: props.rootToken(),
        bucket: props.name,
        scope: chosen,
        // ABSENT is the row's "does not expire"; the form says which it is.
        ...(expiry() === "never" ? {} : { expiresDays: Number(expiry()) }),
      }),
      (answer) => {
        setMinted({ id: answer.facts.id, token: answer.token, scope: answer.facts.scope });
        void refetch();
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
        void refetch();
        return `Revoked ${id}.`;
      },
    );
  };

  return (
    <section class="admin-section" aria-label="tokens">
      <h3>Tokens</h3>
      <div class="cache-create">
        <label class="field-inline">
          <span>scope</span>
          <select
            class="input"
            aria-label="token scope"
            value={scope()}
            onChange={(event) => setScope(event.currentTarget.value === "read" ? "read" : "write")}
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
        <button type="button" class="btn btn-primary" disabled={action.busy()} onClick={mint}>
          {action.busy() ? "working…" : "Mint token"}
        </button>
      </div>
      <Answer control={action} />
      <Show when={minted()}>
        {(held) => (
          <div class="minted">
            <p>
              <strong>Copy this token now.</strong> It is shown once; only a hash is kept.
            </p>
            <pre class="use-block minted-token">{held().token}</pre>
          </div>
        )}
      </Show>
      <Show when={listFault()}>{(message) => <p class="fault">{message()}</p>}</Show>
      <Show
        when={listed().length > 0}
        fallback={
          <Show when={listFault() === null}>
            <p class="hint">{tokens.loading ? "reading…" : "No tokens for this bucket yet."}</p>
          </Show>
        }
      >
        <ul class="tokens">
          <For each={listed()}>
            {(token) => (
              <li>
                <span>
                  <code>{token.id}</code> <span class="pill hue-grey">{token.scope}</span>
                  <Show when={token.id === minted()?.id}>
                    <span class="pill hue-amber">just minted</span>
                  </Show>
                  <Show when={token.bucketGlob !== props.name}>
                    <span class="pill hue-grey">{token.bucketGlob}</span>
                  </Show>
                  <span class="hint"> {tokenLife(token, props.now)}</span>
                </span>
                <Show when={!token.revoked}>
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
    </section>
  );
}

/** Split a box of paths into paths: whitespace, any amount, any kind. */
function pathsOf(raw: string): string[] {
  return raw.split(/\s+/).filter((one) => one !== "");
}

/** `pin.create` — keep a closure out of GC, by name. */
function BucketPin(props: AdminProps & { name: string }): JSX.Element {
  const [pin, setPin] = createSignal("");
  const [paths, setPaths] = createSignal("");
  const action = createControl(props.call);
  const create = (): void => {
    // Sent as typed, empty included: the ROW refuses a nameless or pathless
    // pin in its own words, and that is what the person reads.
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
        return `Pinned ${answer.name}: ${answer.rootPaths.length} path${answer.rootPaths.length === 1 ? "" : "s"} in its closure are kept from GC.`;
      },
    );
  };
  return (
    <section class="admin-section" aria-label="pin">
      <h3>Pin a closure</h3>
      <label class="search">
        <span class="sr-only">pin name</span>
        <input
          type="text"
          class="input"
          placeholder="pin name, e.g. release-1.2"
          value={pin()}
          onInput={(event) => setPin(event.currentTarget.value)}
        />
      </label>
      <label class="search">
        <span class="sr-only">store paths to pin</span>
        <textarea
          class="input"
          rows={3}
          placeholder="/nix/store/… — one or more, space or newline separated"
          value={paths()}
          onInput={(event) => setPaths(event.currentTarget.value)}
        />
      </label>
      <button type="button" class="btn btn-primary" disabled={action.busy()} onClick={create}>
        {action.busy() ? "pinning…" : "Pin closure"}
      </button>
      <Answer control={action} />
    </section>
  );
}

/** `gc.run`, for this bucket. */
function BucketGc(props: AdminProps & { name: string }): JSX.Element {
  const action = createControl(props.call);
  const collect = (): void => {
    action.run(
      props.client.procedures.gc.run({ rootToken: props.rootToken(), bucket: props.name }),
      (report) =>
        `Collected: evicted ${report.evicted} path${report.evicted === 1 ? "" : "s"}` +
        `${report.kept > 0 ? ` (${report.kept} kept by another root)` : ""}, freed ${bytes(report.bytes)}.`,
    );
  };
  return (
    <section class="admin-section" aria-label="garbage collection">
      <h3>Garbage collection</h3>
      <p class="hint">
        Evicts what retention expired AND nothing retained references AND no pin holds.
      </p>
      <button type="button" class="btn" disabled={action.busy()} onClick={collect}>
        {action.busy() ? "collecting…" : "Run GC"}
      </button>
      <Answer control={action} />
    </section>
  );
}

/** `stats.read` — this bucket beside the whole cache. */
function BucketStats(props: AdminProps & { name: string; now: number }): JSX.Element {
  const [stats, { refetch }] = createResource(
    () => props.name,
    async (): Promise<Reading<CacheStats>> => {
      try {
        return {
          ok: true,
          value: await props.call(
            props.client.procedures.stats.read({ rootToken: props.rootToken() }),
          ),
        };
      } catch (err) {
        return { ok: false, message: refusalText(err) };
      }
    },
  );
  const reading = createMemo<CacheStats | null>(() => {
    const answer = stats();
    return answer !== undefined && answer.ok ? answer.value : null;
  });
  const fault = createMemo<string | null>(() => {
    const answer = stats();
    return answer === undefined || answer.ok ? null : answer.message;
  });
  const mine = createMemo(() => reading()?.buckets.find((row) => row.name === props.name));
  return (
    <section class="admin-section" aria-label="stats">
      <h3>Stats</h3>
      <Show when={fault()}>{(message) => <p class="fault">{message()}</p>}</Show>
      <Show when={reading()} fallback={<Show when={fault() === null}><p class="hint">reading…</p></Show>}>
        {(all) => (
          <dl class="stats">
            <dt>this bucket</dt>
            <dd class="bucket-facts">
              <span>{mine()?.objects ?? 0} paths</span>
              <span>{bytes(mine()?.bytes ?? 0)}</span>
              <span>{mine()?.hits ?? 0} reads</span>
            </dd>
            <dt>whole cache</dt>
            <dd class="bucket-facts">
              <span>{all().buckets.length} buckets</span>
              <span>{all().objects} paths</span>
              <span>{bytes(all().bytes)}</span>
              <span>{all().hits} reads</span>
              <span>
                {all().lastAccessed === null
                  ? "never read"
                  : `last read ${ago(all().lastAccessed ?? 0, props.now)}`}
              </span>
            </dd>
          </dl>
        )}
      </Show>
      <button type="button" class="text-action" disabled={stats.loading} onClick={() => refetch()}>
        refresh stats
      </button>
    </section>
  );
}
