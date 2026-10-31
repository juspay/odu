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

import { ago, bytes } from "@odu/cordis/format";
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
  /** MAY THIS PERSON ADMINISTER BUCKETS? The ROW's floor is `admin`, and the
   *  shell reads it off the connection's principal — the face DRAWS what the
   *  role can use and hides the rest. The row REFUSES on its own (`not_permitted`,
   *  `no_root_token`): two independent checks, because a hidden button is not a
   *  permission and a drawn one is not a grant. */
  canAdminister: boolean;
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
          />
        )}
      </Show>
    </>
  );
}

/** THE SENTENCE AN EMPTY NAME GETS, in the row's own voice. The button is not
 *  greyed out for it: a dead control does not say why, and this does. */
export const EMPTY_NAME_FAULT =
  "odu: a bucket needs a name — type one in the box, e.g. my-project";

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
 * A name, and the one creation fact a deployment needs — the upstream switch,
 * on by default — beside the two it is created with (public, ninety days of
 * retention). The button is ENABLED whenever this control is drawn: an empty
 * name is refused on click with a `fault` line like every refusal the row
 * sends, because a person reads a reason and cannot read a grey button.
 */
function CreateBucket(
  props: AdminProps & { onCreated: (bucket: string | null) => void },
): JSX.Element {
  const [name, setName] = createSignal("");
  const [upstream, setUpstream] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);
  const create = (): void => {
    const bucket = name().trim();
    if (bucket === "") {
      setFailure(EMPTY_NAME_FAULT);
      return;
    }
    setBusy(true);
    setFailure(null);
    void props
      .call(
        props.client.procedures.bucket.create({
          // The row ignores this for a signed-in admin (its role authorises the
          // call); only a local owner's token is compared.
          rootToken: props.rootToken(),
          name: bucket,
          public: true,
          retentionDays: 90,
          // ON is the row's own default (nixpkgs' key), so it is left ABSENT;
          // OFF is the empty list, exactly what `--no-upstream` sends.
          ...(upstream() ? {} : { upstreamKeys: [] }),
        }),
      )
      .then(
        (created) => {
          setBusy(false);
          setName("");
          props.onCreated(created.name);
        },
        (err: unknown) => {
          setBusy(false);
          setFailure(refusalText(err));
        },
      );
  };
  return (
    <div class="cache-create">
      <label class="search">
        <span class="sr-only">new bucket name</span>
        <input
          type="text"
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
      <button type="button" disabled={busy()} onClick={create}>
        {busy() ? "creating…" : "Create bucket"}
      </button>
      <Show when={failure()}>{(message) => <p class="fault">{message()}</p>}</Show>
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

/** A refusal as a sentence. The service's refusals are already written for a
 *  person; this only adds the recovery when the error carries one. */
function refusalText(err: unknown): string {
  const value = err as { message?: unknown; suggestion?: unknown };
  const message =
    typeof value?.message === "string" ? value.message : String(err);
  const suggestion = Array.isArray(value?.suggestion)
    ? ` Try: ${(value.suggestion as unknown[]).map(String).join(" ")}`
    : "";
  return `${message}${suggestion}`;
}

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
              {/* The creation fact the upstream switch set, said back: a
                  bucket that takes every path is a choice worth seeing. */}
              <span>
                {row().upstreamKeys.length === 0
                  ? "no upstream filter"
                  : `skips ${row().upstreamKeys.join(", ")}`}
              </span>
            </p>
            {/* THE BLOCK A PERSON PASTES, from the same function `odu cache use`
                prints it with — the page cannot know a home directory, so it
                names `~`. */}
            <pre class="use-block">
              {useBlock({ url: row().url, publicKey: row().publicKey, home: null })}
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
          <BucketAdmin
            client={props.client}
            call={props.call}
            rootToken={props.rootToken}
            name={name}
            now={props.now}
          />
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

/**
 * ONE CONTROL'S STORY: busy, then a receipt or a refusal — and nothing after the
 * control is gone. Owned by the component that made it: `onCleanup` retires it,
 * so an answer that lands after the bucket page closed writes nowhere.
 */
function createAction(call: AdminProps["call"]): {
  readonly busy: () => boolean;
  readonly fault: () => string | null;
  readonly done: () => string | null;
  readonly refuse: (message: string) => void;
  readonly run: <A>(effect: Effect.Effect<A, unknown>, ok: (value: A) => string) => void;
} {
  const [busy, setBusy] = createSignal(false);
  const [fault, setFault] = createSignal<string | null>(null);
  const [done, setDone] = createSignal<string | null>(null);
  let live = true;
  onCleanup(() => {
    live = false;
  });
  return {
    busy,
    fault,
    done,
    refuse: (message) => {
      setDone(null);
      setFault(message);
    },
    run: (effect, ok) => {
      setBusy(true);
      setFault(null);
      setDone(null);
      void call(effect).then(
        (value) => {
          if (!live) return;
          setBusy(false);
          setDone(ok(value));
        },
        (err: unknown) => {
          if (!live) return;
          setBusy(false);
          setFault(refusalText(err));
        },
      );
    },
  };
}

/** What a control answered, drawn the one way every answer on this page is. */
function Answer(props: { action: ReturnType<typeof createAction> }): JSX.Element {
  return (
    <>
      <Show when={props.action.fault()}>{(message) => <p class="fault">{message()}</p>}</Show>
      <Show when={props.action.done()}>{(message) => <p class="hint done">{message()}</p>}</Show>
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
    token.expires === null ? "no expiry" : `expires ${new Date(token.expires).toISOString().slice(0, 10)}`;
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
function BucketAdmin(props: AdminProps & { name: string; now: number }): JSX.Element {
  return (
    <div class="bucket-admin">
      <BucketTokens {...props} />
      <BucketPin {...props} />
      <BucketGc {...props} />
      <BucketStats {...props} />
    </div>
  );
}

/** `token.mint`, `token.list`, `token.revoke` for this bucket. */
function BucketTokens(props: AdminProps & { name: string; now: number }): JSX.Element {
  const [scope, setScope] = createSignal<"write" | "read">("write");
  /** The token just minted — the ONE time its plaintext can be read. */
  const [minted, setMinted] = createSignal<{ id: string; token: string } | null>(null);
  const action = createAction(props.call);

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
      }),
      (answer) => {
        setMinted({ id: answer.facts.id, token: answer.token });
        void refetch();
        return `Minted a ${chosen} token for ${props.name}.`;
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
            aria-label="token scope"
            value={scope()}
            onChange={(event) => setScope(event.currentTarget.value === "read" ? "read" : "write")}
          >
            <option value="write">write — push</option>
            <option value="read">read — substitute</option>
          </select>
        </label>
        <button type="button" disabled={action.busy()} onClick={mint}>
          {action.busy() ? "working…" : "Mint token"}
        </button>
      </div>
      <Answer action={action} />
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
  const action = createAction(props.call);
  const create = (): void => {
    const name = pin().trim();
    const roots = pathsOf(paths());
    // Refused ON CLICK, in the row's voice — the same rule as the bucket form.
    if (name === "") return action.refuse("odu: a pin needs a name — e.g. release-1.2");
    if (roots.length === 0) {
      return action.refuse("odu: a pin needs at least one store path to keep");
    }
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
          placeholder="pin name, e.g. release-1.2"
          value={pin()}
          onInput={(event) => setPin(event.currentTarget.value)}
        />
      </label>
      <label class="search">
        <span class="sr-only">store paths to pin</span>
        <textarea
          rows={3}
          placeholder="/nix/store/… — one or more, space or newline separated"
          value={paths()}
          onInput={(event) => setPaths(event.currentTarget.value)}
        />
      </label>
      <button type="button" disabled={action.busy()} onClick={create}>
        {action.busy() ? "pinning…" : "Pin closure"}
      </button>
      <Answer action={action} />
    </section>
  );
}

/** `gc.run`, for this bucket. */
function BucketGc(props: AdminProps & { name: string }): JSX.Element {
  const action = createAction(props.call);
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
      <button type="button" disabled={action.busy()} onClick={collect}>
        {action.busy() ? "collecting…" : "Run GC"}
      </button>
      <Answer action={action} />
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
