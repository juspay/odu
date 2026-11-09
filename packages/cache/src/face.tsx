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
  type CachePath,
  type CachePaths,
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
  type PathSort,
  pushBlock,
  storePathParts,
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
  /** WHETHER THERE IS A CREDENTIAL TO ASK WITH. A daemon with no door draws
   *  its administration before the owner has typed the root token, and a read
   *  fired then comes back refused — so the page opened with a red box
   *  reporting a token nobody had entered yet. False until there is one. */
  armed: () => boolean;
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

/** WHERE THE EXPLANATION LIVES. A control is its label; the paragraph that
 *  used to sit under it is in the docs, and this is the one link to it. */
function DocsLink(): JSX.Element {
  return (
    <a class="link" href="https://odu.kolu.dev/docs/cache/" target="_blank" rel="noreferrer">
      docs
    </a>
  );
}

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
  // THE FORM IS A CHOICE, NOT THE SCREEN. A list of buckets is what this page
  // is; a form for a new one is something a person does occasionally, and
  // four always-open controls (a secret, a name, a store, a switch) above the
  // list made the occasional thing the first thing.
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

/**
 * ROWS THAT KEEP THEIR IDENTITY ACROSS A PUBLISH.
 *
 * `<For>` keys by the row VALUE, so a publish that re-creates every row object
 * disposes and re-inserts every row — and the button a person was tabbing to,
 * or had focused, is gone. So a row whose facts did not change is handed back as
 * the SAME object: the cache publishes a bundle's counters every second, and a
 * keyboard user should not pay for it.
 */
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
  const stable = keepIdentity<CacheBucket>((row) => row.name);
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
      <PageHead
        title="Cache"
        actions={
          /* THE CREDENTIAL IS THE SCREEN'S, not the create form's. A daemon
             with no door administers by the operator's root token, and on
             this screen that token authorises more than a new bucket — it is
             what the bucket a reader opens next will administer with. Folded
             inside `New bucket` it was a secret you had to open a form to
             type. */
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

/** What a read of one bucket answered: the page, or the sentence explaining why
 *  there is none. A refusal is an ANSWER (`CacheRefused` is a typed failure),
 *  not an outage, so it travels as the value rather than as a resource error. */
type FirstPage =
  | {
      readonly ok: true;
      readonly rows: readonly PathRow[];
      readonly next: string | null;
    }
  | { readonly ok: false; readonly message: string };

/**
 * WHAT AN OPEN PACKAGE'S READ HAS COME TO: it is out, it answered, or it was
 * refused — one fact in one place, so the row can draw all three.
 *
 * A held answer carries its own CURSOR, because a package with a hundred
 * builds is paged exactly like the bucket is: the versions on screen are a
 * page, `next` is where the following one starts, and `reading` is a second
 * page already asked for. A boolean `more` could only say that there WAS
 * another page — which is a sentence to print rather than an action to take.
 */
type Versions =
  | { readonly kind: "reading" }
  | {
      readonly kind: "held";
      readonly versions: readonly CachePath[];
      readonly next: string | null;
      readonly reading: boolean;
    }
  | { readonly kind: "failed"; readonly message: string };

/** How long the filter waits for the typing to stop before it asks. Short
 *  enough that a pause reads as an answer, long enough that a word typed at
 *  speed is one query rather than six. */
const FILTER_DEBOUNCE_MS = 200;

/**
 * WHERE A PERSON PUTS THE TWO FACTS ABOVE — six destinations, one block.
 *
 * The substituter URL and the public key are the whole of reading it, and a
 * write token is the whole of writing to it; what changes is the file they
 * are going into. Six stacked panels made a reader scroll past five they did
 * not want — and put them above the paths, which is what the bucket is for —
 * so this is a tablist over ONE block, at the bottom of the page.
 *
 * The strings are the contract functions `odu cache use` and the docs print,
 * so the page, the terminal and the documentation cannot say three different
 * things.
 *
 * NETRC RIDES `nix.conf` rather than taking a tab of its own: `netrc-file` IS
 * a nix.conf setting, and the credential half is of no use without the pair
 * above it. A reader who needs it (a private bucket) finds it where they are
 * already pasting.
 *
 * ONE TABLE, because a destination is three things that have to agree: the
 * word on its tab, the block it produces, and the class the acceptance suite
 * addresses that block by. Held as a list of names beside a switch for the
 * text and a switch for the class, a seventh destination was three edits —
 * and two of those switches had a default arm that would have taken it
 * silently.
 */
interface SetupDestination {
  /** The word on the tab, and the block's accessible name. */
  readonly name: string;
  /** What the block IS, as the class the acceptance suite addresses it by: a
   *  client's lines, a push, or a workflow step. */
  readonly blockClass: string;
  readonly text: (facts: SetupFacts) => string;
}

/** EVERYTHING ANY DESTINATION COULD NEED, gathered once: the two facts a
 *  client trusts the bucket by, its name, the just-minted WRITE token while
 *  the page may still show it, and the commit the push action is pinned to. */
interface SetupFacts {
  readonly url: string;
  readonly publicKey: string;
  readonly bucket: string;
  readonly token: string | null;
  readonly ref: string;
}

/** Non-empty by its type, because the page opens on the first of them. */
const SETUP_TABS: readonly [SetupDestination, ...SetupDestination[]] = [
  {
    name: "nix.conf",
    blockClass: "consume-block",
    text: (facts) => `${nixConfBlock(facts)}\n\n${netrcBlock({ url: facts.url, home: null })}`,
  },
  { name: "NixOS", blockClass: "consume-block", text: nixOsBlock },
  { name: "flake.nix", blockClass: "consume-block", text: flakeBlock },
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

/** The main column's two lists: what the bucket serves, and what is held in
 *  it against collection. Administration only — a reader who cannot list pins
 *  is drawn the paths with no tablist over them. */
const BUCKET_TABS = ["Paths", "Pins"] as const;
type BucketTab = (typeof BUCKET_TABS)[number];

/** How much of a hash a column shows. Eight base-32 characters is 40 bits —
 *  enough that two builds of one package never collide on this page, and
 *  short enough that the names beside them line up. */
export const HASH_SHOWN = 8;

/** How much of a COMMIT a column shows. Seven hex characters is what git
 *  itself abbreviates to and what a person has in their terminal scrollback,
 *  so the cell matches what they would compare it against. */
const SHA_SHOWN = 7;

/** What the table can be ordered by — the CONTRACT's word, because the order
 *  is the row's to apply. The hash is not among them: it is a random string,
 *  so sorting by it is sorting by nothing, and `wanted` moves under the
 *  reader as pushes renew it. */
export type PathColumn = PathSort;

/**
 * ONE LINE OF THE PATHS TABLE — a package, or a single path.
 *
 * GROUPED is the default because a bucket is mostly one package over and
 * over: a screen of `odu-base-0.1.0` six times, `odu-runner` five times and
 * `odu-web-ui` three times says nothing about what is in the bucket.
 *
 * BOTH KINDS ARE COUNTED BY THE ROW. A group's `versions`, `bytes` and `hits`
 * are the bucket's, counted in SQL over everything that matched the filter —
 * never over the page on screen, which would state one number and then change
 * it at **Show 100 more**. An ungrouped path is the same shape with one
 * version, so the table draws one kind of row either way.
 */
export interface PathRow {
  /** The package name, which is also the key its disclosure is held by. */
  readonly name: string;
  /** The NEWEST version's store path: what the hash cell shows and copies. */
  readonly storePath: string;
  /** How many versions the BUCKET holds — 1 for an ungrouped path. */
  readonly versions: number;
  readonly bytes: number;
  readonly hits: number;
  readonly pushed: number;
  readonly wanted: number;
  /** WHAT BUILT IT, as the push stated it: the run that put it there and the
   *  commit it was built from, or null where nothing was said. A group's are
   *  the NEWEST version's, read off the same row the hash is. */
  readonly run: string | null;
  readonly commit: string | null;
}

/**
 * ONE STORED PATH AS A ROW, and the NAME is the caller's.
 *
 * A path listed on its own is labelled by its package; one listed UNDER its
 * package's row is labelled by nothing, because the row above it already says
 * the name. Everything else is the same reading of the same answer, and said
 * twice — once for the ungrouped page, once for an open package's versions —
 * it was two places to correct when a column moved.
 */
const pathRow = (path: CachePath, name: string): PathRow => ({
  name,
  storePath: path.storePath,
  versions: 1,
  bytes: path.narSize,
  hits: path.hits,
  pushed: path.created,
  wanted: path.lastWanted,
  // A DAEMON OLDER THAN 4.7 ANSWERS NEITHER FIELD, and a path pushed before
  // this said nothing: both read as "unknown", which the cells draw as empty.
  run: path.run ?? null,
  commit: path.commit ?? null,
});

/**
 * THE TABLE, FROM THE PAGE THE ROW ANSWERED — a view, and only a view.
 *
 * Grouping, aggregation and order are the row's (`bucket.paths` takes
 * `group`, `sort` and `descending`), so this is the one mapping left: two
 * answer shapes into the one row the table draws.
 */
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
    }));
  }
  return page.paths.map((path) => pathRow(path, storePathParts(path.storePath).name));
}

/**
 * THE HASH, AND THE WHOLE PATH BEHIND IT.
 *
 * Eight characters is what a person compares two builds by; the other
 * twenty-four are furniture that pushed the name off the screen in the list
 * this table replaced. The full store path is the `title` — and a click puts
 * it on the clipboard, because the reason anybody wants it is to paste it
 * into `nix path-info`, a pin, or a `nix copy`.
 */
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
  // A CELL'S CONTENTS, not a cell: the table draws the `<td>`, and a second
  // one nested inside it is a row the browser lays out twice.
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

/** The pages a reader asked for AFTER the first: what they held, and where
 *  the page after them starts. */
interface AppendedPages {
  readonly rows: readonly PathRow[];
  readonly next: string | null;
}

/**
 * WHAT IS IN A BUCKET — the question, its pages, and the packages opened
 * under them.
 *
 * ITS OWN COMPONENT because it changes for its own reason. Everything here
 * moves when `bucket.paths` moves: its grouping, its orders, its cursors, the
 * columns a header may sort by. The page around it moves when what a bucket
 * IS moves: its retention, its tokens, the block a client pastes. Held in one
 * component, a dozen signals belonging to a list stood between a reader and
 * the six panels that have nothing to do with it.
 *
 * IT HOLDS NO CREDENTIAL, because `bucket.paths` is ungated for the reason
 * the row gives: a bucket's path list is what the substituter already serves,
 * one narinfo at a time, to anybody who can read the bucket.
 */
function BucketPaths(props: {
  client: CacheClient;
  call: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  bucket: string;
  /** The page's clock, stopped while this panel's tab is away. */
  now: number;
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
  // A FILTER IS ABOUT ONE BUCKET. Opening another one starts with an empty box
  // and an empty query, or the second bucket is read through the first one's
  // words and shows nothing.
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

  /**
   * HOW THE TABLE IS ASKED FOR — two switches and a column, every one of them
   * a QUESTION FOR THE ROW rather than a decision about the page on screen.
   *
   * GROUPED BY DEFAULT: a bucket is mostly one package over and over, and the
   * question a reader arrives with ("what is in here, and what is it costing
   * me") is answered by the package, not by its eleventh build. PUSHED-NEWEST
   * by default, because the newest push is what somebody just did.
   */
  const [grouped, setGrouped] = createSignal(true);
  const [column, setColumn] = createSignal<PathColumn>("pushed");
  const [descending, setDescending] = createSignal(true);
  /** A click on the column already sorted REVERSES it; a click on another
   *  takes that column's own natural direction — biggest, newest, most read,
   *  and A before Z. */
  const sortBy = (which: PathColumn): void => {
    if (column() === which) setDescending(!descending());
    else {
      setColumn(which);
      setDescending(which !== "name");
    }
  };

  /**
   * THE PAGES AFTER THE FIRST, AS ONE VALUE — the rows they held, and where
   * the next one starts.
   *
   * `null` is "nothing appended yet"; a `next` of `null` INSIDE it is "this
   * is the end of the list". Those are different facts, and as a cursor
   * signal beside the first page's they shared one spelling: a last page
   * answering no cursor left the FIRST page's standing, so the button under
   * the list stayed and asked for page two a second time, appending it twice.
   */
  const [appended, setAppended] = createSignal<AppendedPages | null>(null);
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

  /** WHAT THE ROW IS ASKED, in one place: the filter, the grouping and the
   *  order, as `bucket.paths` takes them. A page of "more" asks exactly the
   *  same question with a cursor on it. */
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

  /**
   * THE FIRST PAGE, AS A RESOURCE KEYED ON EVERY PART OF THE QUESTION.
   *
   * `createResource` is what makes the filter safe: a keystroke supersedes the
   * read before it, and a superseded answer is DISCARDED rather than painted
   * over a newer one — which is what a bare promise chain did, in whatever order
   * the answers happened to arrive. Its `onCleanup` is the resource's own, so a
   * page that navigates away mid-read leaves nothing running. A sort click and
   * the grouping switch are in the key for the same reason they are the row's
   * to answer: both change which rows the first page holds.
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
    // THE QUESTION IS THE KEY, and the same object is the payload: two
    // spellings of one thing would be two things to keep in agreement.
    () => ({ bucket: props.bucket, ...query() }),
    async (asked): Promise<FirstPage> => {
      setAppended(null);
      setFailure(null);
      setLoadingMore(false);
      // A NEW QUESTION RETIRES EVERY PAGE READ AGAINST THE OLD ONE.
      supersede();
      try {
        const page = await props.call(props.client.procedures.bucket.paths(asked));
        return { ok: true, rows: pathRows(page), next: page.next ?? null };
      } catch (err) {
        return { ok: false, message: refusalText(err) };
      }
    },
  );

  /** A later page. Not a resource: it is a click, and it appends to what the
   *  resource already answered for the SAME question — which is exactly why it
   *  carries the generation it was asked under. */
  const more = (after: string): void => {
    const asked = current();
    setLoadingMore(true);
    // ASKING AGAIN RETIRES THE LAST REFUSAL: it is a sentence about the page
    // that failed, and left standing over the page that arrived it reports a
    // failure this list no longer has.
    setFailure(null);
    void props
      .call(props.client.procedures.bucket.paths({ bucket: props.bucket, ...query(), after }))
      .then(
        (answer) => {
          if (asked !== current()) return; // the question moved on
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

  /** THE ROWS ON SCREEN, their identity KEPT across a page append: a second
   *  page must not dispose and rebuild the hundred rows above it.
   *
   *  BY THE STORE PATH, which is unique in both answers — a package's row
   *  carries its newest version's. A row's NAME is not: ungrouped, three
   *  builds of `widget-1.0` are three rows with one name, and keying on it
   *  would collide them into one slot and rebuild all three every pass. */
  const stable = keepIdentity<PathRow>((row) => row.storePath);
  const rows = createMemo<readonly PathRow[]>(() => {
    const answer = first();
    if (answer === undefined || !answer.ok) return [];
    return [...answer.rows, ...(appended()?.rows ?? [])].map(stable);
  });
  /** WHERE THE NEXT PAGE STARTS — the cursor of the last page actually READ,
   *  which is the appended one from the moment there is one. */
  const next = createMemo<string | null>(() => {
    const been = appended();
    if (been !== null) return been.next;
    const answer = first();
    return answer !== undefined && answer.ok ? answer.next : null;
  });

  /**
   * WHICH PACKAGES ARE OPEN, and what each one's read answered.
   *
   * A group's versions are a READ of their own (`bucket.paths {name}`), not a
   * slice of the page: the page holds one row per package, and the versions
   * under it may not be in it at all. It carries the FILTER too — the count
   * on the row is of what matched, so the list under it must be the same
   * question or the two disagree in front of the reader.
   *
   * ONE MAP, THREE STATES. A read that is out, an answer, and a refusal are
   * one fact about one package; held as a set plus a map there was no place
   * for the refusal at all, and a refused read left the row saying "reading…"
   * for as long as it stayed open.
   */
  const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set());
  const [versions, setVersions] = createSignal<ReadonlyMap<string, Versions>>(new Map());
  const held = (name: string, state: Versions): void => {
    setVersions((all) => new Map(all).set(name, state));
  };
  /** What an OPEN package's read has come to — a closed one draws nothing,
   *  and its answer is kept for the next time it is opened. */
  const openState = (name: string): Versions | undefined =>
    opened().has(name) ? versions().get(name) : undefined;
  /**
   * ONE PACKAGE'S PAGE — the first, or the next one after a cursor.
   *
   * The same read either way, because "open this package" and "show five
   * more of it" are the same question with a different starting point. A
   * page that arrives after the QUESTION changed (a new filter, another
   * bucket) is dropped: `current()` is what was asked.
   */
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
          // WHAT IS ALREADY DRAWN, read at the moment this page LANDS rather
          // than when it was asked for: a cursor's page is appended to the
          // versions on screen now.
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

  /**
   * THE TABLE, AS DATA — eight columns, their widths, and what each cell is.
   *
   * Every width but the name's is fixed, so the name takes what is left and
   * nothing in a cell can widen the page; the `Table` primitive owns the
   * alignment, the clipping and the `aria-sort`.
   */
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
            {/* A BARE NUMBER BESIDE A NAME IS A RIDDLE: what it counts is
                said, in the muted shade a qualifier gets. */}
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
    /**
     * WHAT BUILT IT (cache 4.7). Two cells rather than one: a commit is a
     * fact a reader compares against their own checkout, and a run is a place
     * they go.
     *
     * A SHORT SHA for the same reason the hash cell is short — seven
     * characters is what a person recognises a commit by, and the whole one
     * is the `title`. A path whose push said nothing renders NOTHING here,
     * not a dash: an empty cell reads as "this bucket does not know", while a
     * placeholder reads as a value.
     */
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
      /*
       * THE RUN PAGE IS A HASH ROUTE, and the link is spelled LITERALLY
       * rather than through `runHash()`: this package may not import
       * `@odu/service-client` (`closure.test.ts` holds the fence, because the
       * cache row's client is what `odu cache push` carries and it must not
       * drag the board's client in). The board routes `#/run/<id>`; a bare
       * `/runs/<id>` pathname has no server route and falls through to the
       * board, so the fragment is the whole address.
       */
      cell: (row) =>
        row.run === null ? null : (
          <a class="link" href={`#/run/${encodeURIComponent(row.run)}`} title={row.run}>
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
  ];
  /**
   * AN OPEN PACKAGE'S VERSIONS, as rows of the same shape — one table
   * grammar, not a second one for what hangs under a row.
   *
   * THE NAME IS EMPTY, and that is the point: every one of them is a build
   * of the package named in the row above, so twenty repetitions of
   * `nodejs-22.11.0` down the column say nothing and make the hash — the one
   * thing that differs — the second thing a reader's eye reaches. The
   * indent under the group is what says whose they are.
   */
  const versionsOf = (row: PathRow): readonly PathRow[] => {
    const state = openState(row.name);
    if (state === undefined || state.kind !== "held") return [];
    return state.versions.map((version) => pathRow(version, ""));
  };
  /** What an open package's read has come to, when it is not rows: a read
   *  that is out, a refusal, or THE NEXT PAGE — which is a control, because
   *  a count of what is missing is only useful if it can be asked for. */
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
  // A NEW QUESTION IS A NEW SET OF PACKAGES, and a new answer under each: the
  // filter decides which versions count, so a list read under the old one is
  // not this one's.
  createEffect(
    on(
      () => [props.bucket, filter()] as const,
      () => {
        setOpened(new Set<string>());
        setVersions(new Map());
      },
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
          {/* ONE ROW PER PACKAGE, or one per path. The switch is beside the
              filter because they are the same kind of decision: which of
              what is here do I want to see.

              ONE NAME, WHATEVER IT IS SET TO: `aria-pressed` carries the
              state precisely because the name does not — a control that
              renamed itself as it flipped would announce a different control
              from the one that was pressed. */}
          <button
            type="button"
            class="text-action"
            aria-pressed={grouped()}
            onClick={() => setGrouped(!grouped())}
          >
            group by name
          </button>
          {/* THE LIST IS A SNAPSHOT, and this page's only stale copy: the
              facts line above follows the bucket's row as it publishes,
              while a page read against this bucket is a page — a path a
              build box pushed a minute ago is not in it until somebody
              asks. */}
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
      {/* THE FIRST PAGE'S OWN REFUSAL, from the resource's VALUE — see the
          fetcher: a rejection would be an unhandled one. */}
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
    },
): JSX.Element {
  /** THE REF THE PUSH BLOCK OFFERS — the daemon's own commit when it baked one,
   *  else the placeholder. Read in the bindings below, so a cell that moves
   *  redraws the block. */
  const pushActionRef = (): string => props.pushActionRef() ?? ACTION_REF_PLACEHOLDER;

  /** THE AUTHORITY THE SETTINGS COLUMN IS DRAWN WITH, as the one value
   *  {@link AdminProps} already names: the client, the UI edge, the
   *  credential, and whether there is one to ask with. Seven panels spelling
   *  those four out a prop at a time is seven places to thread one of them
   *  wrongly, and not one of those panels answers any of the four
   *  differently. */
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

  /** Which file the snippet is being pasted into. A page's state and nothing
   *  else: every destination is the same two facts. */
  const [tab, setTab] = createSignal<SetupDestination>(SETUP_TABS[0]);

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

  /** WHAT THE CHOSEN TAB SHOWS, computed once: the block and the button beside
   *  it copy one string, and two calls could not be anything else. */
  const setupText = createMemo<string>(() => {
    const row = bucket();
    if (row === undefined) return "";
    return tab().text({
      url: row.url,
      publicKey: row.publicKey,
      bucket: props.name,
      // A WRITE TOKEN AND ONLY A WRITE ONE: a read token dropped into a push
      // block would be a credential that cannot do what the block around it
      // says.
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
                <BucketPaths
                  client={props.client}
                  call={props.call}
                  bucket={props.name}
                  now={pathsClock()}
                />
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
                    <BucketPins {...admin} name={name} now={pinsClock()} />
                  </div>
                )}
              </Show>

              {/* HOW TO USE THIS BUCKET — LAST, because a reader opens a
                  bucket to see what is in it and sets a client up once. One
                  panel over one tablist: the two facts a client trusts the
                  bucket by, and then whichever file they are going into.

                  The block's CLASS follows the tab, because each of them is a
                  different thing to paste and the acceptance suite addresses
                  them by what they are: `consume-block` is what a client
                  reads with, `push-block` what a build pushes with,
                  `actions-push-block` the workflow step. */}
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
              </Panel>
            </div>

            {/* THE BUCKET'S SETTINGS — what this bucket IS, rather than what is
                in it. Drawn for the row's floor and KEYED on the name: a minted
                token and a GC report belong to ONE bucket, so opening another
                builds these afresh rather than carrying a secret across. */}
            <Show when={props.canAdminister ? props.name : null} keyed>
              {(name) => (
                <div class="split-side">
                  <Show when={props.local}>
                    {/* ONE WORD FOR THE STATE, where a sentence about
                        `$ODU_ROOT_TOKEN` used to be: a box with something in
                        it is the credential every control beside it asks
                        with, and a wrong one is reported by the control that
                        was refused rather than guessed at here. */}
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
                  {/* A CONTROL THAT CANNOT FIRE IS NOT A CONTROL. Until the
                      root token is held, every panel below would draw its
                      fields, its lists and its buttons and refuse every one
                      of them — six panels of furniture over a box somebody
                      has not filled in yet. So the column IS the box until
                      there is a credential in it, and the rest appear the
                      moment there is one. */}
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
                    {/* LAST, BEHIND A RULE OF ITS OWN: every control above
                        changes what this bucket does and can be changed back.
                        This one ends it, so it is not a seventh panel in the
                        stack — a reader scrolling the settings meets a heading
                        that says what the rest of the column is. */}
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
  // NOTHING TO DECIDE, NOTHING TO DRAW: a daemon that declares one store has
  // nowhere to move a bucket to, and a panel whose whole content is a note
  // saying so is a line of the settings column spent on a non-choice. It
  // reappears by itself on a daemon that declares a second store — and a move
  // already running is always drawn, whatever the stores say now.
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
                          {/* The one hued thing here: a token in its one
                              showing is a STATE of this page, not a property
                              of the token. */}
                          <Pill hue="amber">just minted</Pill>
                        </Show>
                        <Show when={token.bucketGlob !== props.name}>
                          <Tag>{token.bucketGlob}</Tag>
                        </Show>
                        {/* WHO MINTED IT, when anything said so (PLAN 4.1): a
                            run's own write token reads `run <id>`, which is
                            what tells an operator a credential they did not
                            issue is odu's and expires with its run. */}
                        <Show when={token.label}>
                          {(label) => <Tag>{label()}</Tag>}
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

/** Whitespace, without a pattern: every check in {@link pinName} is a single
 *  pass, and a `\s` test is the one place a regex could creep back in. */
function hasSpace(text: string): boolean {
  for (const ch of text) if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") return true;
  return false;
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
    props,
    async (bucket) =>
      (await props.call(props.client.procedures.pin.list({ rootToken: props.rootToken(), bucket })))
        .pins,
  );
  const listed = (): readonly CachePin[] => pins.value() ?? [];

  /**
   * WHICH CLOSURES A READER ASKED TO SEE — by name AND the moment it was
   * pinned, because re-pointing a pin keeps the name and replaces the closure
   * (`db.ts`'s upsert writes `root_paths` and `created` together). Keyed by
   * name alone, a CI push re-pointing `…@master/x86_64-linux` would draw all
   * 1 789 roots of a closure nobody asked about.
   *
   * The state is the LIST's and not a row's: `pin.list` is asked again after
   * every create and unpin, and rows rebuilt from that answer would take
   * their open bit with them — an audit of a 1 789-root pin collapsing
   * because somebody removed an unrelated one.
   */
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set());
  /** Which pins have their roots open — the DISCLOSURE's state, held here for
   *  the same reason "show all" is: a republish re-mints every row. */
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

  /** Whether the form is open. A form nobody is filling in is three controls
   *  between a reader and the list they came for. */
  const [forming, setForming] = createSignal(false);

  /**
   * THE TABLE, AS DATA — a pin is a line like everything else on this board.
   *
   * The name takes what is left; every other width is fixed, so a pin named
   * by a CI push cannot widen the page. What it HOLDS is the note under the
   * row, because roots are store paths and a column of them is the wall this
   * page stopped drawing.
   */
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
          {/* THE REPOSITORY IS PART OF THE NAME, muted: two branches called
              `master` in one bucket are two different repositories, and a
              column that drops the owner says they are the same pin. */}
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
      // WHO MADE IT decides who may re-point it — and an administrator who
      // re-points a pushed pin TAKES IT OVER: the next push naming it is
      // refused and that workflow step goes red, loudly.
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

  /** WHAT A PIN HOLDS, when somebody asks: the roots are the whole answer to
   *  "may this one go?", and the count in the row is the whole answer to "how
   *  much". `data-pin` rides the box because the acceptance suite counts one
   *  pin's roots and a note row is a SIBLING of the row it belongs to. */
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
                {/* AN EMPTY LIST IS A CLAIM, and a page that never asked
                    cannot make it: without a root token `pin.list` is not
                    called at all, so "nothing is pinned" would be a lie told
                    to whoever has not typed the secret yet. */}
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
 * `gc.plan` AND `gc.run`, for this bucket — the dry run beside the collection.
 *
 * The question a person asks at this button is "what am I about to lose", and
 * a report answering it afterwards is an answer that arrived too late. So the
 * plan is read when it is asked for and again after every collection: the
 * count and the total are the whole truth, the paths under them are as much
 * of it as anybody reads first, and they come oldest want first, so the top
 * line is the first to go.
 */
function BucketGc(
  props: AdminProps & { name: string; now: number; retentionDays: number },
): JSX.Element {
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
      label="garbage collection"
      actions={<DocsLink />}
    >
      <div class="panel-body">
        <div class="stack">
          <div class="control-row">
            <Button disabled={action.busy()} onClick={collect}>
              {action.busy() ? "collecting…" : "Run GC"}
            </Button>
            {/* WHAT THE BUTTON WILL ASK, on the button: "dry run retention
                days / its own" was a label and a placeholder read as one
                fragment, and the number typed into it changed nothing a
                reader could see until the answer came back. */}
            <Button disabled={plan.loading() || asking().kind === "bad"} onClick={askAgain}>
              {plan.loading()
                ? "counting…"
                : asking().kind === "own"
                  ? "Dry run"
                  : `Dry run at ${retention().trim()} day${retention().trim() === "1" ? "" : "s"}`}
            </Button>
            {/* THE DRY RUN'S OWN NUMBER, beside the button it belongs to and
                nowhere near "Set retention" above: this one asks, that one
                keeps. Blank is the bucket's own, and the placeholder says
                which number that is rather than leaving it to be guessed. */}
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
