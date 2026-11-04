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
 * ## It draws INSIDE the shell's frame
 *
 * The shell (`@odu/web-ui`'s `app.tsx`) owns the rail, the wordmark and the row
 * switch, and mounts this inside its `main`. So a screen here starts at its own
 * `PageHead` and never draws a masthead, a page frame or a way back to another
 * row: it is a column of panels, in the vocabulary `@odu/face`'s theme defines,
 * and every surface it draws is one of that vocabulary's words.
 *
 * ## What a bucket page answers
 *
 * The three facts a client needs and nothing else: the substituter URL, the
 * public key, and the block `odu cache use` prints — as text a person copies.
 * Those two facts ride `KeyValue` rows with a copy button each, because that is
 * what somebody actually takes; the SNIPPET under them is the same pair spelled
 * for whichever file it is going into, which is a TAB rather than four stacked
 * blocks nobody scrolls past. Then the bucket's PATHS, newest first, with the
 * filter box narrowing them: the question "did my build actually land" is asked
 * by scrolling, and asked again by typing a derivation's name.
 *
 * ## Reading needs no secret; administering is the row's floor
 *
 * The READS never go through a gated verb. `bucket.paths` and
 * `bucket.describe` take none, which is the cache's own decision — a bucket's
 * URL, key and path list are what the substituter publishes to anyone who can
 * read it — so a member's view asks them without holding anything.
 *
 * Every OTHER verb of the row has a control here too, because the board does
 * everything the row's API does, and for most of it the board is the only
 * door a person has: create (with the upstream switch), and per bucket set
 * the retention, mint / list / revoke a token, pin a closure and list or
 * unpin the pins, see what the next collection would take before running it,
 * run GC, read stats. They
 * are DRAWN for the row's floor (the shell's `canAdminister`) and REFUSED by
 * the row on its own — never one check standing in for the other. On a bucket
 * page they are the narrow column beside what everyone reads.
 */

import { createControl, type Control } from "@odu/face/control";
import { ago, bytes } from "@odu/cordis/format";
import { refusalText } from "@odu/face/refusal";
import {
  BackLink,
  Button,
  CopyButton,
  Choice,
  Field,
  KeyValue,
  PageHead,
  Panel,
  Pill,
  Receipt,
  SearchInput,
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
  type JSX,
} from "solid-js";
import {
  type CacheBucket,
  type CacheGcPlan,
  type CacheMigration,
  type CachePath,
  type CachePin,
  type CacheToken,
  flakeBlock,
  netrcBlock,
  nixConfBlock,
  nixOsBlock,
  oduCacheSurface,
  PATH_PAGE_SIZE,
  ACTION_REF_PLACEHOLDER,
  DEFAULT_RETENTION_DAYS,
  LOCAL_STORE,
  actionsPushBlock,
  pushBlock,
  useCommand,
  type CacheScope,
} from "./surface";

type CacheSpec = (typeof oduCacheSurface)["spec"];

/**
 * WHO ANSWERS A READ OF THIS BUCKET, as the facts line says it (PLAN 2.8).
 *
 * `readsFrom` is the row's own answer and the URL beside it is where it
 * points, so the sentence names the HOST rather than repeating the whole
 * substituter line the "Use it" block already carries. Exported and pure, so
 * both halves are pinned by a unit test rather than by reading JSX.
 */
export function readsFromText(bucket: Pick<CacheBucket, "readsFrom" | "url">): string {
  if (bucket.readsFrom !== "store") return "reads served by odu";
  try {
    return `reads served from ${new URL(bucket.url).host}`;
  } catch {
    // A URL this row could not parse is still the fact it advertised; printing
    // it whole beats printing nothing where a person is checking a domain.
    return `reads served from ${bucket.url}`;
  }
}

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
  /** WHICH COMMIT THE DAEMON WAS BUILT FROM, as an ACCESSOR — the service
   *  cell's `build.commit`, read live, since a page left open across a service
   *  handover should offer the build that is serving it now. The shell holds
   *  the runs' client and so the cell; this face holds the cache's and cannot
   *  reach it. `null` for a build that baked none. */
  pushActionRef: () => string | null;
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
   *  role, so the page asks for it once (the same secret the daemon reads from
   *  `$ODU_ROOT_TOKEN`), and an empty list points at the form above it. */
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

/** The two halves of the local owner's secret, threaded to wherever the field
 *  is drawn: what is in the box, and how it changes. The SIGNAL lives in
 *  {@link CacheFace}, because the bucket page's controls read it long after the
 *  list screen where it was typed is gone. */
interface TokenField {
  typedToken: () => string;
  onTypedToken: (value: string) => void;
}

export function CacheFace(props: CacheFaceProps): JSX.Element {
  // THE PAGE'S ONE COPY OF THE ROOT TOKEN, for as long as the cache is on
  // screen and no longer: a signal owned by this face, never written to storage,
  // and gone when the shell switches rows.
  const [rootToken, setRootToken] = createSignal("");
  const admin: AdminProps & TokenField = {
    get client() {
      return props.client;
    },
    get call() {
      return props.call;
    },
    rootToken: () => (props.local ? rootToken() : ""),
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
        />
      )}
    </Show>
  );
}

/**
 * THE SECRET A DAEMON WITH NO DOOR ADMINISTERS BY.
 *
 * Drawn beside the controls it authorises rather than floating above the page:
 * it is a credential for the administration, not a property of the screen. A
 * password field, never stored, and its accessible name is `root token` — the
 * name the acceptance suite types into and the name `$ODU_ROOT_TOKEN` carries.
 */
function RootTokenField(props: TokenField): JSX.Element {
  return (
    <Field
      id="cache-root-token"
      label="root token"
      hint="What this daemon's administration checks — the same secret odu cache reads from $ODU_ROOT_TOKEN. It is held for this page only."
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

/** WHY THE UPSTREAM SWITCH EXISTS, in the docs' one line: a store that did not
 *  build the paths never holds nixpkgs, so a bucket that skips upstream paths
 *  makes every push wait at 202 for referrers that will never arrive. */
export const UPSTREAM_HINT =
  "Skip paths cache.nixos.org already signed. Turn off for a server whose " +
  "store is not the machine that built the paths, or every push waits at 202 " +
  "(the CLI's --no-upstream).";

/** The cache screen's one sentence: what a bucket IS, before any of them are
 *  read. The stores are named because where the objects live is the one
 *  creation fact that cannot be changed afterwards. */
const CACHE_SUB =
  "Nix binary caches, one per bucket. Each keeps its objects on this server's " +
  "disk or in an S3 store.";

/**
 * CREATE A BUCKET.
 *
 * A name, and the creation facts a deployment needs — the upstream switch, on
 * by default, and WHERE its objects live when this daemon declared more than
 * its own disk — beside the two it is created with (public, ninety days of
 * retention). The stores are the row's `stores` cell, drawn as the row names
 * them: the face spells no store, not even the default — the cell marks it,
 * and choosing it sends nothing, so the row's own default applies.
 *
 * The store is a RADIO CARD per store rather than a `<select>`, because the
 * options need explaining: "this server's disk" and "an S3 bucket somewhere
 * else" is a deployment decision, and a menu hides the sentence that makes it
 * behind a click.
 *
 * The button is ENABLED whenever this control is drawn: the name is sent as
 * typed, empty included, and the ROW's refusal is what the person reads — one
 * rule, in one place, rather than a face's copy of it.
 */
function CreateBucket(
  props: AdminProps &
    TokenField & { local: boolean; onCreated: (bucket: string | null) => void },
): JSX.Element {
  const [name, setName] = createSignal("");
  const [upstream, setUpstream] = createSignal(true);
  /** The stores this daemon declared; one store is no choice, so no control. */
  const stores = props.client.cells.stores.use();
  const offered = createMemo(() => stores.value() ?? []);
  /** The entry the row marks as its default: the card that starts chosen. */
  const fallback = createMemo(() => offered().find((one) => one.default)?.name ?? "");
  /** `null` while the default is chosen: nothing is sent, and the row decides. */
  const [store, setStore] = createSignal<string | null>(null);
  const chosen = createMemo(() => store() ?? fallback());
  const control = createControl(props.call);
  const create = (): void => {
    control.run(
      props.client.procedures.bucket.create({
        // The row ignores this for a signed-in admin (its role authorises the
        // call); only a local owner's token is compared.
        rootToken: props.rootToken(),
        name: name().trim(),
        public: true,
        // RETENTION IS NOT A CREATION FORM'S BUSINESS: absent is the row's
        // own default, and `bucket.retention` on the bucket page is where a
        // deployment that wants another number says so.
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
    <Panel title="New bucket" class="panel-dashed" label="new bucket">
      <div class="panel-body">
        <div class="form">
          <Show when={props.local}>
            <RootTokenField
              typedToken={props.typedToken}
              onTypedToken={props.onTypedToken}
            />
          </Show>
          <Field id="new-bucket-name" label="Name">
            <TextInput
              id="new-bucket-name"
              value={name()}
              placeholder="new bucket name"
              onValue={setName}
            />
          </Field>
          <Show when={offered().length > 1}>
            <fieldset class="toggles">
              <legend>Where its objects live</legend>
              <div class="form-pair">
                <For each={offered()}>
                  {(one) => (
                    <Choice
                      name="bucket-store"
                      value={one.name}
                      checked={chosen() === one.name}
                      label={one.name}
                      note={
                        (one.kind === "local" ? "This server's disk." : "An S3 store.") +
                        (one.default ? " The default." : "")
                      }
                      onPick={(picked) =>
                        setStore(picked === fallback() ? null : picked)
                      }
                    />
                  )}
                </For>
              </div>
            </fieldset>
          </Show>
          <fieldset class="toggles">
            <legend>Upstream</legend>
            <Toggle id="new-bucket-upstream" checked={upstream()} onChecked={setUpstream}>
              Skip upstream paths
            </Toggle>
            <p class="hint">{UPSTREAM_HINT}</p>
          </fieldset>
          <Button class="btn-primary" disabled={control.busy()} onClick={create}>
            {control.busy() ? "creating…" : "Create bucket"}
          </Button>
          <Answer control={control} />
        </div>
      </div>
    </Panel>
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
  // No door: the person at this machine owns it, and a shell is how they have
  // always done it — the form below works too, with the root token.
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
    <section class="screen cache" aria-label="buckets">
      <PageHead title="Cache" sub={CACHE_SUB} />

      <Show
        when={rows().length > 0}
        fallback={
          <p class="empty">
            {emptyBucketsText({ canAdminister: props.canAdminister, local: props.local })}
          </p>
        }
      >
        {/* THE GRID IS THE BUCKETS. The screen's one heading is the ROW's name
            ("Cache"); the cards under it need naming for whoever is not looking
            at them, and a list's own label is that name — not a second heading
            saying what the list already is. */}
        <ul class="buckets cards" aria-label="Buckets">
          <For each={rows()}>
            {(bucket) => (
              <li>
                {/* A real button: reachable by Tab, fired by Enter and Space,
                    announced as a control. The card IS the link, so the whole
                    card is the hit target rather than the name inside it. */}
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
                    {/* WHERE THE BYTES ARE, as a property and not a status: the
                        design canvas tints R2 orange and local blue, and this
                        page spends colour on run state alone — so a store is a
                        plain grey `Tag` like every other fact about a thing. */}
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
                    {/* What it takes to read it, and how long what it holds
                        survives: the two creation facts a card's foot carries. */}
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
      {/* The ROW's floor made visible: creating a bucket needs an `admin`, so a
          member is not shown a form whose call would be refused. */}
      <Show when={props.canAdminister}>
        <CreateBucket
          client={props.client}
          call={props.call}
          rootToken={props.rootToken}
          typedToken={props.typedToken}
          onTypedToken={props.onTypedToken}
          local={props.local}
          onCreated={props.onOpen}
        />
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

/**
 * WHERE A PERSON PUTS THE TWO FACTS ABOVE — four destinations, one block.
 *
 * The substituter URL and the public key are the whole of it; what changes is
 * the file they are going into. Four stacked blocks made a reader scroll past
 * three they did not want, so this is a tablist over ONE snippet — and it is
 * the same contract functions `odu cache use` and the docs print, so the page,
 * the terminal and the documentation cannot say three different things.
 *
 * NETRC RIDES `nix.conf` rather than taking a tab of its own: `netrc-file` IS
 * a nix.conf setting, and the credential half is of no use without the pair
 * above it. A reader who needs it (a private bucket) finds it where they are
 * already pasting; a reader who does not reads two extra commented lines.
 */
const SNIPPET_TABS = ["nix.conf", "NixOS", "flake.nix", "odu CLI"] as const;
type SnippetTab = (typeof SNIPPET_TABS)[number];

/** The main column's two lists: what the bucket serves, and what is held in
 *  it against collection. Administration only — a reader who cannot list pins
 *  is drawn the paths with no tablist over them. */
const BUCKET_TABS = ["Paths", "Pins"] as const;
type BucketTab = (typeof BUCKET_TABS)[number];

function snippetFor(
  where: SnippetTab,
  input: { readonly url: string; readonly publicKey: string; readonly bucket: string },
): string {
  switch (where) {
    case "nix.conf":
      return `${nixConfBlock(input)}\n\n${netrcBlock({ url: input.url, home: null })}`;
    case "NixOS":
      return nixOsBlock(input);
    case "flake.nix":
      return flakeBlock(input);
    case "odu CLI":
      return useCommand(input.bucket);
  }
}

/** A store path's dim half and its read half: `/nix/store/<hash>-` is furniture
 *  and the name after it is what somebody is looking for. */
function splitStorePath(storePath: string): { readonly hash: string; readonly name: string } {
  const dash = storePath.indexOf("-", storePath.lastIndexOf("/") + 1);
  if (dash === -1) return { hash: "", name: storePath };
  return { hash: storePath.slice(0, dash + 1), name: storePath.slice(dash + 1) };
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
    },
): JSX.Element {
  /** THE REF THE PUSH BLOCK OFFERS — the daemon's own commit when it baked one,
   *  else the placeholder. Read in the bindings below, so a cell that moves
   *  redraws the block. */
  const pushActionRef = (): string => props.pushActionRef() ?? ACTION_REF_PLACEHOLDER;

  /** Which file the snippet is being pasted into. A page's state and nothing
   *  else: every tab is the same two facts. */
  const [tab, setTab] = createSignal<SnippetTab>("nix.conf");

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

  /** WHICH LIST THE MAIN COLUMN DRAWS. The paths and the pins are the same
   *  kind of thing — what is in this bucket — so they are two tabs over one
   *  column rather than a list beside a sidebar panel that printed every root
   *  of every pin. A member is drawn no pins at all, so for them there is one
   *  tab and the state is ignored. */
  const [listing, setListing] = createSignal<BucketTab>("Paths");
  const shown = (): BucketTab => (props.canAdminister ? listing() : "Paths");

  /**
   * A CLOCK THAT STOPS WHILE ITS PANEL IS AWAY.
   *
   * `props.now` ticks once a second for the whole page, and a path row reads
   * it twice (`created`, `lastWanted`) while a pin row reads it once. Keeping
   * both panels mounted is what saves the paged-in paths and the half-typed
   * pin — but a `display: none` subtree redrawing 600 relative times a second
   * is exactly the invisible DOM work this page exists to cut. One gate, read
   * twice: the page owns which panel is up, so it hands each the `now` that
   * applies to it.
   */
  const clockWhile = (which: BucketTab): (() => number) =>
    createMemo<number>((prev) => (shown() === which ? props.now : prev), props.now);
  const pathsClock = clockWhile("Paths");
  const pinsClock = clockWhile("Pins");

  /** The push block, computed once: the button copies the string the block
   *  shows, and two calls could not be anything else. */
  const pushText = createMemo<string>(() => {
    const row = bucket();
    if (row === undefined) return "";
    return pushBlock({
      url: row.url,
      token: minted()?.scope === "write" ? (minted()?.token ?? null) : null,
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
                  {/* THE NAME, not a claim about the route. Whether the record
                      answers is the tunnel row's fact and this row cannot see
                      it, so the tag carries no hue. */}
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
                {/* THE NUMBER IS THE FACT and the word is what it counts, so
                    the number is the emphasised half — the same split a `Stat`
                    makes on a card, in one line. */}
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
                {/* WHERE THE BYTES ARE: the store it was created on. */}
                <span>objects on {row().store}</span>
                {/* AND WHO ANSWERS A READ OF THEM (2.8): the store's own
                    domain when it publishes one, else this daemon — which is
                    the difference between a cache that serves while odu is
                    down and one that does not. */}
                <span>{readsFromText(row())}</span>
                {/* The creation fact the upstream switch set, said back: a
                    bucket that takes every path is a choice worth seeing. */}
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
              {/* HOW TO USE THIS BUCKET: the two facts a client trusts it by,
                  each with the button that takes it, and the same pair spelled
                  for whichever file it is going into. */}
              <Panel
                title="Use it"
                note="Two facts make a Nix client trust this bucket."
                label="use it"
              >
                <KeyValue label="Substituter" value={row().url}>
                  <CopyButton text={row().url} />
                </KeyValue>
                <KeyValue label="Public key" value={row().publicKey}>
                  <CopyButton text={row().publicKey} />
                </KeyValue>
                <div class="tabs" role="tablist" aria-label="where to put it">
                  <For each={SNIPPET_TABS}>
                    {(where) => (
                      <button
                        type="button"
                        role="tab"
                        class="tab"
                        aria-selected={tab() === where}
                        onClick={() => setTab(where)}
                      >
                        {where}
                      </button>
                    )}
                  </For>
                </div>
                {/* ONE BLOCK, RE-RENDERED. `consume-block` is the class the
                    acceptance suite reads the substituter and netrc lines out
                    of, and it stays one element whichever tab is chosen. */}
                <pre class="use-block consume-block" role="tabpanel" aria-label={tab()}>
                  {snippetFor(tab(), {
                    url: row().url,
                    publicKey: row().publicKey,
                    bucket: props.name,
                  })}
                </pre>
              </Panel>

              <Panel
                title="Push to it"
                note={
                  minted()?.scope === "write"
                    ? "With the write token you just minted — paste it into your build's secrets now; it is not shown again."
                    : props.canAdminister
                      ? "Mint a write token beside this page, and this block fills it in while it can be shown."
                      : "With a write token an admin of this server mints for you."
                }
                label="push to it"
                actions={<CopyButton text={pushText()} />}
              >
                <pre class="use-block push-block">{pushText()}</pre>
              </Panel>

              <Panel
                title="Push from GitHub Actions"
                note={
                  pushActionRef() === ACTION_REF_PLACEHOLDER
                    ? "The action odu ships: it builds its own odu from the revision you pin it to, pushes this bucket, and fails if a path it pushed does not answer here. Pin a revision — that commit is the pusher. Nix must already be on the runner."
                    : `The action odu ships: it builds its own odu from the revision you pin it to, pushes this bucket, and fails if a path it pushed does not answer here. This block pins ${pushActionRef()} — the commit this server was built from, so the pusher matches the cache you are looking at. Nix must already be on the runner.`
                }
                label="push from github actions"
                actions={
                  <CopyButton
                    text={actionsPushBlock({
                      url: row().url,
                      ref: pushActionRef(),
                    })}
                  />
                }
              >
                <pre class="use-block actions-push-block">
                  {actionsPushBlock({
                    url: row().url,
                    ref: pushActionRef(),
                  })}
                </pre>
              </Panel>

              {/* WHAT IS IN THIS BUCKET — the paths it serves, and (for an
                  administrator) the pins holding some of them against every
                  collection. One column, two tabs: a pin is about the paths
                  beside it, and a sidebar panel printing every root of every
                  pin was most of this page's DOM.

                  BOTH PANELS STAY MOUNTED and the chosen one is SHOWN, which
                  is the rule the snippet tablist above keeps for its own
                  block. A switch that disposed them would throw away three
                  loaded pages of paths (the DOM work this page exists to
                  avoid) with the filter's caret, and the half-typed pin whose
                  store path the reader came to the other tab to copy. */}
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

              {/* A TABPANEL ONLY WHERE THERE IS A TABLIST: a member is drawn
                  no Pins tab, so for them this is a plain box rather than a
                  panel announced as part of a tab set that does not exist,
                  named by an IDREF that resolves to nothing. */}
              <div
                class="tab-host"
                id="bucket-panel-Paths"
                role={props.canAdminister ? "tabpanel" : undefined}
                aria-labelledby={props.canAdminister ? "bucket-tab-Paths" : undefined}
                hidden={shown() !== "Paths"}
              >
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
                      {/* THE LIST IS A SNAPSHOT, and this page's only stale
                          copy: the facts line above follows the bucket's row
                          as it publishes, while a page read against this
                          bucket is a page — a path a build box pushed a
                          minute ago is not in it until somebody asks. */}
                      <button
                        type="button"
                        class="text-action"
                        disabled={first.loading}
                        onClick={() => refetch()}
                      >
                        {first.loading ? "reading…" : "refresh paths"}
                      </button>
                    </>
                  }
                >
                  {/* THE FIRST PAGE'S OWN REFUSAL, from the resource's VALUE — see
                      the fetcher: a rejection would be an unhandled one. */}
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
                    when={paths().length > 0}
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
                    <ol class="paths">
                      <For each={paths()}>
                        {(path) => (
                          <li>
                            <code class="path">
                              <span class="path-hash">{splitStorePath(path.storePath).hash}</span>
                              {splitStorePath(path.storePath).name}
                            </code>
                            <span class="fact-line bucket-facts">
                              <span>{bytes(path.narSize)}</span>
                              <span>{ago(path.created, pathsClock())}</span>
                              <span>{path.hits} reads</span>
                              {/* WANTED, not read: retention counts from here,
                                  and the reads beside it never move it. */}
                              <span>wanted {ago(path.lastWanted, pathsClock())}</span>
                            </span>
                          </li>
                        )}
                      </For>
                    </ol>
                  </Show>
                  <Show when={next()}>
                    {(after) => (
                      <div class="panel-foot">
                        <Button
                          disabled={loadingMore() || first.loading}
                          onClick={() => more(after())}
                        >
                          {loadingMore() ? "reading…" : `Show ${PATH_PAGE_SIZE} more`}
                        </Button>
                      </div>
                    )}
                  </Show>
                </Panel>
              </div>

              {/* KEYED ON THE NAME AND NOTHING ELSE: a half-typed pin belongs
                  to the bucket it was typed on, and to no particular tab. */}
              <Show when={props.canAdminister ? props.name : null} keyed>
                {(name) => (
                  <div
                    class="tab-host"
                    role="tabpanel"
                    id="bucket-panel-Pins"
                    aria-labelledby="bucket-tab-Pins"
                    hidden={shown() !== "Pins"}
                  >
                    <BucketPins
                      client={props.client}
                      call={props.call}
                      rootToken={props.rootToken}
                      name={name}
                      now={pinsClock()}
                    />
                  </div>
                )}
              </Show>
            </div>

            {/* THE BUCKET'S SETTINGS — what this bucket IS, rather than what is
                in it. Drawn for the row's floor and KEYED on the name: a minted
                token and a GC report belong to ONE bucket, so opening another
                builds these afresh rather than carrying a secret across. */}
            <Show when={props.canAdminister ? props.name : null} keyed>
              {(name) => (
                <div class="split-side">
                  <Show when={props.local}>
                    <Panel title="Root token">
                      <div class="panel-body">
                        <RootTokenField
                          typedToken={props.typedToken}
                          onTypedToken={props.onTypedToken}
                        />
                      </div>
                    </Panel>
                  </Show>
                  <BucketTokens
                    client={props.client}
                    call={props.call}
                    rootToken={props.rootToken}
                    minted={minted()}
                    onMinted={setMinted}
                    name={name}
                    now={props.now}
                  />
                  <BucketRetention
                    client={props.client}
                    call={props.call}
                    rootToken={props.rootToken}
                    name={name}
                    retentionDays={bucket()?.retentionDays ?? DEFAULT_RETENTION_DAYS}
                  />
                  <BucketDomain
                    client={props.client}
                    call={props.call}
                    rootToken={props.rootToken}
                    name={name}
                    domain={bucket()?.domain ?? null}
                    tunnelRow={props.tunnelRow}
                  />
                  <BucketMigrate
                    client={props.client}
                    call={props.call}
                    rootToken={props.rootToken}
                    name={name}
                    store={bucket()?.store ?? LOCAL_STORE}
                    migration={bucket()?.migration ?? null}
                  />
                  <BucketGc
                    client={props.client}
                    call={props.call}
                    rootToken={props.rootToken}
                    name={name}
                    now={props.now}
                  />
                  {/* LAST, BEHIND A RULE OF ITS OWN: every control above
                      changes what this bucket does and can be changed back.
                      This one ends it, so it is not a seventh panel in the
                      stack — a reader scrolling the settings meets a heading
                      that says what the rest of the column is. */}
                  <div class="danger-zone">
                    <h2 class="danger-zone-head">Danger zone</h2>
                    <BucketDelete
                      client={props.client}
                      call={props.call}
                      rootToken={props.rootToken}
                      name={name}
                      onDeleted={() => props.onOpen(null)}
                    />
                  </div>
                </div>
              )}
            </Show>
          </div>
        )}
      </Show>
    </section>
  );
}

// ── a bucket's administration ───────────────────────────────────────────────

/** What a control answered, drawn the one way every answer on this board is: a
 *  receipt, refusals included — a control that went quiet on a refusal is the
 *  browser's version of the failure this release removes. */
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

/** A read that answers a value OR the sentence explaining why there is none —
 *  the same rule {@link FirstPage} keeps, for the same reason. */
type Reading<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** What a READ on this page is: a value, the sentence saying why there is
 *  none, whether it is in flight, and the way to ask again. */
interface Read<T> {
  value: () => T | null;
  fault: () => string | null;
  loading: () => boolean;
  refetch: () => void;
}

/**
 * ONE SHAPE FOR EVERY GATED READ on this page — the tokens, the pins and the
 * dry run were three copies of it, and they had already drifted on the
 * decision that matters: WHEN to ask again. The key is `[bucket, token]`,
 * because on a daemon with no door the root token is a box the local owner
 * fills AFTER the page draws, and a list keyed on the bucket alone shows "the
 * root token does not match" until it is reloaded. A refusal is a VALUE here,
 * never a rejection: a rejected resource is an unhandled rejection in Solid.
 */
function reading<T>(
  key: () => string | null,
  rootToken: () => string,
  ask: (bucket: string) => Promise<T>,
): Read<T> {
  const [answer, { refetch }] = createResource(
    () => {
      const named = key();
      return named === null ? null : ([named, rootToken()] as const);
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
    <Panel title="A name of its own" label="domain">
      <div class="panel-body">
        <div class="stack">
          <p class="hint">
            A DNS name for this bucket, with no scheme and no port. When it is set,
            the substituter URL, the netrc block and the push block use it. The
            NixOS module needs a virtual host for the same name; a bucket on the
            public pod gets one through a tunnel row.
          </p>
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

/**
 * HOW LONG A PATH OUTLIVES WANTING — the bucket's retention, in days.
 *
 * It is the one creation fact a bucket is allowed to change its mind about,
 * and the number the facts line at the top of this page prints: the row
 * republishes, so setting it here moves that line without this control
 * holding a copy of it. ZERO is a real answer rather than an empty box — keep
 * only what a reference or a pin holds, which is what a scratch bucket wants —
 * so the field offers it and the sentence below says which it was.
 */
function BucketRetention(
  props: AdminProps & { name: string; retentionDays: number },
): JSX.Element {
  const [typed, setTyped] = createSignal(String(props.retentionDays));
  createEffect(
    on(() => props.retentionDays, (days) => setTyped(String(days)), { defer: true }),
  );
  /** WHOLE NUMBERS ONLY, because this one field cannot be sent as typed: a box
   *  holding "" or "two weeks" fails the contract's own encoding and never
   *  reaches the row to be refused in words. The RANGE stays the row's — a
   *  negative is a number, so it travels and comes back refused where every
   *  other bad input does. */
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
      note="Days a path survives from the last time anything WANTED it — a push, or a `missing` query that named it. Reads do not count: they are leaving odu, so the busiest paths would be the first to look idle."
      label="retention"
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

/**
 * A MOVE IN PROGRESS, as one sentence (PLAN 2.8).
 *
 * The three states are three different things to be waiting for — the copy,
 * the moment the bucket changes hands, and the old copies going away — so the
 * sentence names which, rather than printing a bar that means "something is
 * happening". Exported and pure: the wording is pinned by a unit test, and
 * the panel below is then only the subscription.
 */
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

/**
 * WHERE A BUCKET'S OBJECTS LIVE, changed — `bucket.migrate`.
 *
 * The one creation fact that used to be final. The cards are the stores this
 * daemon declared MINUS the one it is on, because moving a bucket where it
 * already is is a refusal rather than a choice; a daemon that declares only
 * its own disk has nowhere to move anything, and says so instead of offering
 * an empty fieldset.
 *
 * PROGRESS IS THE ROW'S, not this panel's. A move is minutes of copying and
 * the bucket's row already streams its `migration` deltas to this page, so
 * the panel reads the prop and holds no copy of it — nothing here polls, and
 * nothing here can disagree with the board. While one is running the Start
 * control is not drawn at all: a second move of the same bucket is refused by
 * the row, and a button whose only answer is "already moving" is noise.
 */
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
  /** `null` until somebody picks: the first offered store is the card that
   *  starts chosen, and the pick survives a republish of the list. */
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
    <Panel
      title="Move to another store"
      note="Copies every object to another declared store. The bucket keeps serving from the old store until the copy is done."
      label="migrate"
    >
      <div class="panel-body">
        <div class="stack">
          <Show
            when={props.migration}
            fallback={
              <Show
                when={elsewhere().length > 0}
                fallback={
                  <p class="hint">
                    This daemon declares only one store, so there is nowhere to move
                    this bucket.
                  </p>
                }
              >
                <fieldset class="toggles">
                  <legend>Where to move it</legend>
                  <div class="form-pair">
                    <For each={elsewhere()}>
                      {(one) => (
                        <Choice
                          name="migrate-store"
                          value={one.name}
                          checked={target() === one.name}
                          label={one.name}
                          note={
                            one.kind === "local" ? "This server's disk." : "An S3 store."
                          }
                          onPick={(name) => setPicked(name)}
                        />
                      )}
                    </For>
                  </div>
                </fieldset>
                <Button class="btn-primary" disabled={action.busy()} onClick={start}>
                  {action.busy() ? "starting…" : "Start move"}
                </Button>
              </Show>
            }
          >
            {(moving) => <p class="hint migration-progress">{migrationText(moving())}</p>}
          </Show>
          <Answer control={action} />
        </div>
      </div>
    </Panel>
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

  const tokens = reading(
    () => props.name,
    props.rootToken,
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
        // ABSENT is the row's "does not expire"; the form says which it is.
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
            {/* The accessible name is the `aria-label` and not the word beside
                it: "scope" alone names nothing on a page with two of them. */}
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
                <p class="hint">
                  <strong>Copy this token now.</strong> It is shown once; only a hash is
                  kept.
                </p>
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
                          {/* The one hued thing here: a token in its one
                              showing is a STATE of this page, not a property
                              of the token. */}
                          <Pill hue="amber">just minted</Pill>
                        </Show>
                        <Show when={token.bucketGlob !== props.name}>
                          <Tag>{token.bucketGlob}</Tag>
                        </Show>
                      </span>
                      <span class="hint">{tokenLife(token, props.now)}</span>
                    </span>
                    <Show when={!token.revoked}>
                      {/* A RAW BUTTON, because its accessible name has to name
                          WHICH token: a column of controls all called "revoke"
                          is a column a screen reader cannot tell apart, and the
                          `Button` primitive takes no `aria-label`. */}
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

/** Split a box of paths into paths: whitespace, any amount, any kind. */
function pathsOf(raw: string): string[] {
  return raw.split(/\s+/).filter((one) => one !== "");
}

/**
 * WHAT A PIN'S NAME SAYS.
 *
 * A pin CI keeps current is named by the push action, never typed:
 * `<owner>/<repo>@<ref>/<system>`. That is three facts in one string, and a
 * flat list of forty of them is forty strings a person reads character by
 * character to find the one branch they care about. Split here so the page
 * can group by the repository and draw the ref and the system as what they
 * are.
 *
 * A name that is NOT that shape is a person's own (`release-1.2`), and it
 * keeps its whole name: inventing a repository for it would be a guess
 * printed as a fact.
 */
export interface PinName {
  /** `<owner>/<repo>`, or null for a hand-made pin. */
  readonly repo: string | null;
  /** The ref the push was on, or the whole name when there is no repo. */
  readonly ref: string;
  readonly system: string | null;
}

/**
 * SPLIT, NEVER MATCHED — and that is a security property, not a style.
 *
 * This was one regex with `.+` between the `@` and the last `/`. A pin name
 * arrives from the API, so it is input; CodeQL's `js/polynomial-redos` is
 * right that `!/!/!/!/…` makes that pattern backtrack quadratically, and a
 * bucket holding one hostile pin would hang the tab that listed it.
 *
 * A regex was buying nothing here. Three index scans answer the same
 * question in one pass of the string, and each shape check below is a
 * bounded test on a slice:
 *
 *   - the repo is everything before the FIRST `@`, and must be
 *     `<owner>/<name>` — exactly one slash, neither half empty;
 *   - the system is everything after the LAST `/` of the rest, and must look
 *     like a Nix double (`x86_64-linux`): hyphenated, no whitespace;
 *   - the ref is what is left between them, and MAY contain slashes
 *     (`release/2.0`), which is why the system is taken from the end.
 *
 * A name that fails any of them is somebody's own and keeps all of itself:
 * inventing a repository for `release-1.2` would be a guess printed as a
 * fact.
 */
function pinName(name: string): PinName {
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

/** Whitespace, without a pattern: every check in {@link pinName} is a single
 *  pass, and a `\s` test is the one place a regex could creep back in. */
function hasSpace(text: string): boolean {
  for (const ch of text) if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") return true;
  return false;
}

/** The pins of one repository, in the order the row answered. */
export interface PinGroup {
  /** The heading: a repository, or the word for everything hand-made. */
  readonly repo: string;
  readonly pins: ReadonlyArray<{ readonly pin: CachePin; readonly parsed: PinName }>;
}

/**
 * GROUPED, in first-seen order — never sorted.
 *
 * The row answers pins newest first, and that order is information: the pin a
 * person just made, or the branch CI last pushed, is the one they came to
 * look at. Sorting by name would bury it under whatever is alphabetically
 * first. Hand-made pins come last under one heading, because they are the
 * exception and a reader scanning repositories should not have to step over
 * them.
 */
export function pinGroups(pins: ReadonlyArray<CachePin>): ReadonlyArray<PinGroup> {
  const byRepo = new Map<string, { pin: CachePin; parsed: PinName }[]>();
  const loose: { pin: CachePin; parsed: PinName }[] = [];
  for (const pin of pins) {
    const parsed = pinName(pin.name);
    if (parsed.repo === null) {
      loose.push({ pin, parsed });
      continue;
    }
    const held = byRepo.get(parsed.repo);
    if (held === undefined) byRepo.set(parsed.repo, [{ pin, parsed }]);
    else held.push({ pin, parsed });
  }
  const groups = [...byRepo].map(([repo, held]) => ({ repo, pins: held }));
  return loose.length === 0 ? groups : [...groups, { repo: "Pinned by hand", pins: loose }];
}

/**
 * `pin.create`, `pin.list` and `pin.delete` for this bucket.
 *
 * A pin holds its roots and whatever they reference inside this bucket
 * against every collection, however long nobody wants them, until it is
 * removed here.
 */
function BucketPins(props: AdminProps & { name: string; now: number }): JSX.Element {
  const [pin, setPin] = createSignal("");
  const [paths, setPaths] = createSignal("");
  const action = createControl(props.call);

  const pins = reading(
    () => props.name,
    props.rootToken,
    async (bucket) =>
      (await props.call(props.client.procedures.pin.list({ rootToken: props.rootToken(), bucket })))
        .pins,
  );
  const listed = (): readonly CachePin[] => pins.value() ?? [];

  /**
   * ROWS THAT SURVIVE A REPUBLISH, and the expansion that rides on them.
   *
   * `pinGroups` mints fresh objects every call, so a refetch — a pin created,
   * one removed — would hand `<For>` all-new identities and dispose every
   * row: an audit of a 1 789-root pin collapsing because somebody unpinned
   * something else. Two things keep it open.
   *
   * THE HEADING IS THE KEY, not the group. `<For>` keys a string by VALUE, so
   * a repository whose name is still in the list is still the same item
   * however its pins moved — where a group OBJECT holding its pins changed
   * identity whenever any pin under it did, taking the whole repository's
   * rows with it. The pins hang off a `Map` read by that heading.
   *
   * AND EACH ROW KEEPS ITS OWN IDENTITY while its facts hold, so removing one
   * pin disposes that row and no other. A row IS the pin — `CachePin` already
   * carries the `name` {@link keepIdentity} compares by, and the split name
   * is a pure function of it, derived where it is drawn. The `<details>` open
   * state is the DOM's own and rides on this identity.
   */
  const stableRow = keepIdentity<CachePin>();
  const grouped = createMemo<ReadonlyMap<string, ReadonlyArray<CachePin>>>(
    () =>
      new Map(
        pinGroups(listed()).map((group) => [
          group.repo,
          group.pins.map((held) => stableRow(held.pin)),
        ]),
      ),
  );
  const headings = createMemo<readonly string[]>(() => [...grouped().keys()]);
  /**
   * WHICH CLOSURES A READER ASKED TO SEE WHOLE — by name AND the moment it
   * was pinned, because re-pointing a pin keeps the name and replaces the
   * closure (`db.ts`'s upsert writes `root_paths` and `created` together).
   * Keyed by name alone, a CI push re-pointing `…@master/x86_64-linux` would
   * draw all 1 789 roots of a closure nobody asked about; keyed by both, the
   * list forgets exactly when the `<details>` it rode on does.
   */
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  const closureKey = (pin: CachePin): string => `${pin.name}@${pin.created}`;
  const showAll = (key: string): void => {
    setExpanded((held) => new Set(held).add(key));
  };

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

  return (
    <Panel
      class="cache-pins"
      title="Pins"
      note="A pin holds its roots, and whatever they reference inside this bucket, against every collection — however long nobody wants them — until it is removed here."
      label="pins"
      actions={
        /* The other snapshot on this page: this list is read once per bucket
           and after this page's own create or unpin, so a pin a CI push
           re-pointed since then is still drawn as it was. */
        <button
          type="button"
          class="text-action"
          disabled={pins.loading()}
          onClick={pins.refetch}
        >
          {pins.loading() ? "reading…" : "refresh pins"}
        </button>
      }
    >
      <div class="panel-body">
        <div class="stack">
          <Field id="pin-name" label="pin name">
            <TextInput
              id="pin-name"
              value={pin()}
              placeholder="release-1.2"
              onValue={setPin}
            />
          </Field>
          <Field
            id="pin-paths"
            label="store paths to pin"
            hint="One or more, space or newline separated."
          >
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
          <Answer control={action} />
          <Show when={pins.fault()}>{(message) => <p class="fault">{message()}</p>}</Show>
          <Show
            when={listed().length > 0}
            fallback={
              <Show when={pins.fault() === null}>
                <p class="hint">
                  {pins.loading() ? "reading…" : "Nothing is pinned in this bucket."}
                </p>
              </Show>
            }
          >
            {/* ONE LIST, GROUPED — `ul.pins` stays the list the acceptance
                suite reads a pin out of, and the repository headings are
                items in it rather than a second list per repo: a pin is a
                pin whichever heading it sits under. */}
            <ul class="pins facts">
              <For each={headings()}>
                {(repo) => (
                  <>
                    <li class="pin-group">{repo}</li>
                    <For each={grouped().get(repo) ?? []}>
                      {(held) => (
                        <PinnedRow
                          pin={held}
                          now={props.now}
                          busy={action.busy()}
                          all={expanded().has(closureKey(held))}
                          onShowAll={() => showAll(closureKey(held))}
                          onUnpin={unpin}
                        />
                      )}
                    </For>
                  </>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </div>
    </Panel>
  );
}

/**
 * HOW MANY ROOTS A PIN SHOWS BEFORE IT IS ASKED FOR THE REST.
 *
 * A pin a CI push takes over a flake's whole output set holds every path in
 * it: one pin on the production board held 1 789, and seven pins printed
 * 3 276 store paths — about nine tenths of that page's DOM, with the controls
 * under it pushed off the screen. Ten is enough to recognise WHAT a pin
 * holds; the count beside it is the whole of how much, and the rest are one
 * click away.
 */
const PIN_ROOTS_SHOWN = 10;

/**
 * ONE PIN, ONE ROW — the three facts about it, and its roots behind a
 * disclosure.
 *
 * `PinnedRow`, not `PinRow`: `db.ts` already calls a pin's DATABASE row that,
 * and two things one name inside one package is a reading mistake waiting to
 * happen.
 *
 * WHETHER IT IS EXPANDED IS THE LIST'S, not this row's: `pin.list` is asked
 * again after every create and unpin, and a row rebuilt by that answer would
 * take its own state with it — an audit of a 1 789-root pin collapsing
 * because somebody removed an unrelated one.
 */
function PinnedRow(props: {
  pin: CachePin;
  now: number;
  busy: boolean;
  all: boolean;
  onShowAll: () => void;
  onUnpin: (name: string) => void;
}): JSX.Element {
  /** The name, split into the three facts it carries — a pure function of the
   *  pin, derived where it is drawn rather than carried beside it. */
  const parsed = createMemo<PinName>(() => pinName(props.pin.name));
  const shown = createMemo<readonly string[]>(() =>
    props.all ? props.pin.rootPaths : props.pin.rootPaths.slice(0, PIN_ROOTS_SHOWN),
  );
  const rest = (): number => props.pin.rootPaths.length - shown().length;
  return (
    <li>
      <span class="pin">
        <span class="pin-head">
          <code>{parsed().ref}</code>
          <Show when={parsed().system}>{(system) => <Tag>{system()}</Tag>}</Show>
        </span>
        <span class="fact-line">
          <span>
            {props.pin.rootPaths.length} path
            {props.pin.rootPaths.length === 1 ? "" : "s"} in its closure
          </span>
          <span>pinned {ago(props.pin.created, props.now)}</span>
          {/* WHO MADE IT decides who may re-point it — and an admin who
              re-points a pushed pin TAKES IT OVER: the next push naming it is
              refused and that workflow step goes red, loudly. */}
          <span>
            {props.pin.createdBy === "write"
              ? "made by a push, which may re-point it"
              : "made by an administrator: a push can no longer move it"}
          </span>
        </span>
        {/* WHAT IT HOLDS, when somebody asks: the roots are the whole answer
            to "may this one go?", and the count above is the whole answer to
            "how much". A native `<details>` because the four behaviours a
            disclosure needs are the four the platform implements. */}
        <details class="pin-roots-box">
          <summary>what it holds</summary>
          <span class="pin-roots">
            <For each={shown()}>{(root) => <code class="path">{root}</code>}</For>
          </span>
          <Show when={rest() > 0}>
            <button type="button" class="text-action" onClick={props.onShowAll}>
              show all {props.pin.rootPaths.length}
            </button>
          </Show>
        </details>
      </span>
      <button
        type="button"
        class="text-action"
        aria-label={`unpin ${props.pin.name}`}
        disabled={props.busy}
        onClick={() => props.onUnpin(props.pin.name)}
      >
        unpin
      </button>
    </li>
  );
}

/**
 * `gc.plan` AND `gc.run`, for this bucket — the dry run beside the collection.
 *
 * The question a person asks at this button is "what am I about to lose", and
 * a report answering it afterwards is an answer that arrived too late. So the
 * plan is read when it is asked for and again after every collection: the
 * count and the total are the whole truth, the paths under them are as much
 * of it as anybody reads first, and they come oldest want first, so the top
 * line is the first to go.
 */
function BucketGc(props: AdminProps & { name: string; now: number }): JSX.Element {
  const action = createControl(props.call);
  /** THE RETENTION THE PLAN ASKS WITH, blank for the bucket's own. It is read
   *  when the button is pressed rather than watched, because a plan that
   *  re-ran on every keystroke would ask the row a question per digit — and
   *  because `0` and `01` are the same number typed half way. */
  const [retention, setRetention] = createSignal("");
  /** WHAT THE BOX MEANS, as three answers rather than a number with a magic
   *  value among its range: the bucket's OWN retention (blank), a number of
   *  DAYS to ask with, or a box this field cannot send at all — the
   *  contract's `Int` would fail to encode and never reach the row to be
   *  refused in words. The RANGE stays the row's: a negative travels. */
  const asking = createMemo<{ kind: "own" } | { kind: "days"; days: number } | { kind: "bad" }>(
    () => {
      const typed = retention().trim();
      if (typed === "") return { kind: "own" };
      const parsed = Number(typed);
      return Number.isInteger(parsed) ? { kind: "days", days: parsed } : { kind: "bad" };
    },
  );
  /** THE DRY RUN IS ASKED FOR, NEVER TAKEN ON ARRIVAL: the key is null until
   *  the button is pressed, because at mount a daemon with no door has an
   *  empty root-token box and an eager plan would greet its local owner with
   *  "the root token does not match" before they had typed anything. */
  const [asked, setAsked] = createSignal(false);
  /** WHAT THE ANSWER ON SCREEN IS AN ANSWER TO, not what the box says now —
   *  which is why it is written when the plan LANDS. A second press is a
   *  refetch of the same key, so the previous answer stays drawn for the
   *  length of the round trip; writing this on the way out would hang the
   *  new retention's sentence over the old retention's count. A refusal
   *  leaves it where it was, beside the answer still on screen. */
  const [answeredWith, setAnsweredWith] = createSignal<number | null>(null);
  const plan = reading(
    () => (asked() ? props.name : null),
    props.rootToken,
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
  /** Ask for it: the button, and what a collection does to its own answer —
   *  but only when somebody had asked, since a collection must not turn a
   *  silent section into one. */
  const askAgain = (): void => {
    if (!asked()) setAsked(true);
    else plan.refetch();
  };
  /** This bucket's share of the plan. A plan that does not mention it has
   *  nothing to say about it, which is not the same as not having answered. */
  const next = (): CacheGcPlan["buckets"][number] | null =>
    plan.value()?.buckets.find((row) => row.bucket === props.name) ?? null;
  const collect = (): void => {
    action.run(
      props.client.procedures.gc.run({ rootToken: props.rootToken(), bucket: props.name }),
      (report) =>
        `Collected: evicted ${report.evicted} path${report.evicted === 1 ? "" : "s"}` +
        `${report.kept > 0 ? ` (${report.kept} whose bytes a twin path still names)` : ""}` +
        `, freed ${bytes(report.bytes)}` +
        // The objects no row ever named — a put whose record never landed.
        // They are bytes nothing on this page could list, so the one moment
        // they are visible is the pass that swept them.
        `${report.orphans > 0 ? ` and ${report.orphans} orphaned object${report.orphans === 1 ? "" : "s"}` : ""}.`,
      // WHATEVER THE COLLECTION ANSWERED, a plan somebody asked for is now a
      // guess — so it is asked again, and a section nobody asked stays quiet.
      () => {
        if (asked()) plan.refetch();
      },
    );
  };
  return (
    <Panel
      title="Garbage collection"
      note="Evicts what retention expired AND nothing retained references AND no pin holds."
      label="garbage collection"
    >
      <div class="panel-body">
        <div class="stack">
          <div class="control-row">
            <Button disabled={action.busy()} onClick={collect}>
              {action.busy() ? "collecting…" : "Run GC"}
            </Button>
            <Button disabled={plan.loading() || asking().kind === "bad"} onClick={askAgain}>
              {plan.loading() ? "counting…" : "Dry run"}
            </Button>
            {/* THE DRY RUN'S OWN NUMBER, beside the button it belongs to and
                nowhere near "Set retention" above: this one asks, that one
                keeps. Blank is the bucket's own. */}
            <Field id="gc-retention-days" label="dry run retention days">
              <input
                id="gc-retention-days"
                type="number"
                class="input"
                min="0"
                step="1"
                placeholder="its own"
                value={retention()}
                onInput={(event) => setRetention(event.currentTarget.value)}
              />
            </Field>
          </div>
          <Answer control={action} />
          <Show when={plan.fault()}>{(message) => <p class="fault">{message()}</p>}</Show>
          <Show when={next()}>
            {(would) => (
              <>
                <p class="hint">
                  {/* WHICH QUESTION THIS ANSWER IS TO. A plan taken at a
                      retention the bucket does not have is not what the next
                      collection would do, and the sentence has to say so. */}
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
                      The {would().paths.length} oldest wants are listed; the count
                      and the total above are the whole of it.
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

/**
 * TAKE THIS BUCKET AWAY — `bucket.delete`, and the one control here with no
 * undo behind it.
 *
 * So it is GATED ON THE NAME: the button does nothing until the operator has
 * typed the bucket's own name back, exactly, which is the convention a person
 * already knows from deleting a repository. A confirmation dialog would be
 * one keystroke on a control that destroys every object in a bucket; retyping
 * the name is the one gesture that cannot be made by muscle memory, and it
 * also names WHICH bucket, which is the mistake this guards against — the
 * operator with two tabs open.
 *
 * On success the page LEAVES: the bucket it was drawing does not exist, and
 * every read on it is about to refuse. The list it returns to has already
 * dropped the row, because the row's own collection published its removal.
 */
function BucketDelete(
  props: AdminProps & { name: string; onDeleted: () => void },
): JSX.Element {
  const [typed, setTyped] = createSignal("");
  const action = createControl(props.call);
  const confirmed = createMemo(() => typed() === props.name);
  // LEAVE ON THE ANSWER, not on the call: `Control.run`'s own `after` fires on
  // a refusal too, and a page that navigated away from a bound-domain refusal
  // would hide the sentence that says what to do about it. `done()` is the OK
  // arm alone.
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
      note="Removes every object, path, token and pin in it. There is no undo. A bucket with a domain keeps its name until you clear it above."
      label="delete"
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
