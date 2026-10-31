/**
 * THE SHELL — the address bar's router, the wire indicator, the rows switch, and
 * the tab. It renders no run and no bucket: those are `@odu/ci/face` and
 * `@odu/cache/face`, each in the package that owns the row it draws.
 *
 * **Two rows, two faces, one page.** The header's switch is two STATES of this
 * page rather than a menu; the route decides which face is mounted, and each
 * face gets the client of its own row and the route's slice of the address. A
 * face cannot reach across — the runs' views hold the runs' client, the cache's
 * holds the cache's — and the shell is the one file that wires both.
 *
 * **THE UI EDGE IS HERE, once.** A procedure is an `Effect` — a description —
 * and a click is the moment one becomes execution. `call` below is that
 * crossing for BOTH faces (`props.call`), so "a control's whole story" has one
 * home and two views cannot disagree about what a refusal means.
 *
 * **The connection is drawn, not hidden.** The readout is the framework's own
 * five-state fact — connecting, live, degraded, reconnecting, retired — and
 * each is a state a person can be in and needs to know about. `reconnecting` is
 * the honest one: the page keeps showing the last thing the service said, and
 * says so rather than letting stale rows look live.
 */

import type { SurfaceReadout } from "@kolu/surface/solid";
import {
  CiFace,
  ciAmbient,
  type CiAmbient,
  type CiClient,
  type CiRoute,
} from "@odu/ci/face";
import { CacheFace, type CacheClient } from "@odu/cache/face";
import { LOCAL_OWNER, may, type Principal, type Role } from "@odu/cordis/principal";
import {
  ProfileFace,
  SignIn,
  SignedInHeader,
  type AuthClient,
  type Who,
} from "@odu/auth/face";

import { Effect } from "effect";
import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  on,
  onCleanup,
  Show,
  type JSX,
} from "solid-js";
import { parseRunHash, runHash, logHash } from "@odu/service-client/routes";
import { Button } from "@odu/ci/face";
import { faviconSvg, wireText } from "./format";

/**
 * Where the page is, in the URL hash.
 *
 * The RUN ADDRESS itself — what `#/run/<id>` names, and what makes a run and one
 * node's output within it linkable — is `@odu/service-client/routes`, minted and
 * read there because a link is minted by whoever holds the run (an editor, a
 * terminal, another app's panel) and opened here. What stays local is the rest of
 * this page's states: `#/` for the runs, `#/new` for the create form,
 * `#/cache[/<bucket>]` for the other row, and `#/profile` for the signed-in
 * person's sessions and tokens.
 */
type Route = CiRoute | { at: "cache"; bucket: string | null } | { at: "profile" };

/**
 * DOES THIS DAEMON HAVE A DOOR? `null` when the answer could not be fetched
 * before the first render — a daemon that is down, not one without a door.
 */
export type DoorState = boolean | null;

/**
 * WHO THIS PAGE APPLIES A ROW'S FLOOR TO. Pure, and exported, because it is the
 * one decision every control's visibility rests on:
 *
 *   - **no door** (`false`) ⇒ the LOCAL OWNER. A loopback daemon has no
 *     identity provider, so the person at this machine IS its owner and every
 *     floor is held — the same rule `may()` states for `local`.
 *   - **door, whoami still in flight, or anonymous** ⇒ nobody. Nothing
 *     privileged is drawn before the answer arrives, and a sign-in page draws
 *     none of it.
 *   - **door, answered with a person** ⇒ that person, with their role.
 */
export function principalOf(door: DoorState, who: Who | null): Principal | null {
  if (door === false) return LOCAL_OWNER;
  if (door === null) return null;
  return who === null || who.kind === "anonymous" ? null : who;
}

/** Does this principal hold `floor`? Nothing held by nobody. */
export function holds(principal: Principal | null, floor: Role): boolean {
  return principal !== null && may(principal, floor);
}

/** May the board be drawn? With no door it always may; with one, only for a
 *  person who is not anonymous; with an unknown door, not until it answers. */
export function showsBoard(door: DoorState, who: Who | null): boolean {
  if (door === false) return true;
  if (door === null) return false;
  return who !== null && who.kind !== "anonymous";
}

function routeOf(hash: string): Route {
  const run = parseRunHash(hash);
  if (run !== null) return { at: "run", ...run };
  const rest = hash.replace(/^#\/?/, "");
  if (rest === "new") return { at: "new" };
  if (rest === "profile") return { at: "profile" };
  if (rest === "cache") return { at: "cache", bucket: null };
  if (rest.startsWith("cache/")) {
    const name = decodeURIComponent(rest.slice("cache/".length));
    return { at: "cache", bucket: name === "" ? null : name };
  }
  return { at: "board" };
}

function hashOf(route: Route): string {
  switch (route.at) {
    case "board":
      return "#/";
    case "new":
      return "#/new";
    case "profile":
      return "#/profile";
    case "run":
      return route.log === null ? runHash(route.runId) : logHash(route.log);
    case "cache":
      return route.bucket === null ? "#/cache" : `#/cache/${encodeURIComponent(route.bucket)}`;
  }
}

export function App(props: {
  client: CiClient;
  /** ASKS THE HOST WHETHER IT HAS A DOOR, once more — `main.tsx` owns the
   *  request (it is a host route, and the fence keeps host routes to the entry),
   *  and this component owns the moment to make it. */
  redialDoor: () => void;
  /** THE CACHE'S CLIENT — a different row, handed to the one face that renders
   *  it and to nothing else. */
  cache: CacheClient;
  /** THE AUTH ROW'S CLIENT. Its surface is always dialled (the bundle carries
   *  the contract), but the row may not be MOUNTED — `door` is the host's answer
   *  to that question, read before the first render. */
  auth: AuthClient;
  /** Does this daemon have a DOOR? The host answers `GET /_odu/door` before the
   *  first render; `null` means the answer did not arrive. */
  door: DoorState;
  readout: SurfaceReadout;
  onReload: () => void;
}): JSX.Element {
  const [route, setRoute] = createSignal<Route>(
    routeOf(globalThis.location?.hash ?? ""),
  );
  const go = (next: Route): void => {
    // The hash is the source of truth, so Back works: pushing it fires
    // `hashchange`, which is what actually moves the signal.
    globalThis.location.hash = hashOf(next);
  };
  const onHash = (): void => {
    // A THUNK, not the value: Solid's setter treats a function as an updater,
    // so `setRoute(routeOf(...))` would work while `setRoute(route)` for a
    // route that happens to be callable would not. Wrapping is the spelling
    // that is right whatever the value's shape.
    setRoute(() => routeOf(globalThis.location.hash));
  };
  globalThis.addEventListener("hashchange", onHash);
  onCleanup(() => globalThis.removeEventListener("hashchange", onHash));

  // A clock the ages read. One interval for the whole page rather than one per
  // row, and `unref`-less because a browser has no such notion — `onCleanup`
  // is the disposal that matters here.
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(clock));

  // ── the tab ──
  //
  // THE TAB IS THE AMBIENT MONITOR, and the counts are the RUNS' — the board's
  // rows, folded by `@odu/ci/face`. What they must NOT be is the runs' FACE's:
  // a face unmounts when another row is on screen, and a run that fails while
  // somebody reads buckets is exactly the fact the tab exists to carry. So the
  // shell owns the subscription once, here, and the face is handed the same
  // reading when it is drawn. A page left open is a page nobody is looking at,
  // and a title and a favicon are the two pixels that stay visible from another
  // window. Broken outranks busy: a run still going is worth a glance, a
  // failure is worth coming back for — and it is a WORD as well as a glyph,
  // because a title read aloud is the only version of this some people get.
  //
  // BUILT LAZILY, and that is a door fact: the monitor subscribes to `runs`, and
  // a server with a door refuses that subscription to a connection with no
  // session. Opening it on the sign-in page would be a subscription that dies on
  // arrival, four times a second. So it opens when the board does.
  const [ambient, setAmbient] = createSignal<CiAmbient | null>(null);
  const restingIcon =
    typeof document === "undefined"
      ? null
      : (document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href ??
        null);
  createEffect(() => {
    if (typeof document === "undefined") return;
    const held = ambient();
    if (held === null) {
      // Nobody is looking at runs: the tab says nothing about them.
      document.title = "odu";
      return;
    }
    const { failing, active } = held.tally();
    document.title =
      failing > 0
        ? `✗ ${failing} failing · odu`
        : active > 0
          ? `● ${active} running · odu`
          : "odu";
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link === null) return;
    link.href =
      failing > 0
        ? faviconSvg("red")
        : active > 0
          ? faviconSvg("amber")
          : // No resting icon means the document had no `<link rel="icon">` when
            // this shell was built, so there is nothing to go back TO: leave the
            // mark the page is wearing rather than blanking it.
            (restingIcon ?? link.href);
  });

  // ── the door ──
  //
  // TWO FACTS, and neither is guessed. Whether this daemon HAS a door is the
  // host's own answer, fetched before this page was even rendered (`./main`),
  // so the shell never opens the board for a moment on a server it turns out
  // cannot serve it. `whoami` says who this connection is — `anonymous` when
  // the gate let us in without a session, which is a page before it signs in
  // rather than an error. With no door, nothing is asked and the header is
  // exactly today's.
  const [who, setWho] = createSignal<Who | null>(null);

  // A LIVE WIRE RE-ASKS WHAT AN OUTAGE MADE STALE. Two questions ride the same
  // event, so they are one effect:
  //
  //   - THE DOOR, always. The ask before the first render can fail while the
  //     wire is still redialling, and an unknown door draws the header and
  //     nothing else; the shell owns the connection, so the shell owns the
  //     retry. No timer — a timer would be a second opinion about the wire.
  //   - THE PERSON, on a transition back to live. Signing out in one tab, a
  //     revocation and an expiry all end the lease; the tab holding it is
  //     severed and redials, and what comes back is a NEW connection that may
  //     well be nobody — which is also why the second tab of "sign out in one
  //     tab" ends up on the sign-in page.
  createEffect(
    on(
      () => props.readout.status,
      (status, previous) => {
        if (status !== "live") return;
        props.redialDoor();
        if (previous !== undefined && previous !== "live") setWho(null);
      },
    ),
  );

  createEffect(() => {
    if (props.door !== true || who() !== null) return;
    void Effect.runPromise(props.auth.procedures.user.whoami({})).then(
      (answer) => setWho(answer.who),
      // A failed whoami on a daemon that says it has a door is a broken
      // connection, not a person: the wire readout already says so, and a
      // sign-in form would be a guess. Leave the page where it is until the
      // readout recovers and the effect runs again.
      () => {},
    );
  });
  /** THE CONNECTION'S PRINCIPAL, as a row reads it — the one decision every
   *  control's visibility rests on (see {@link principalOf}). */
  const principal = createMemo(() => principalOf(props.door, who()));
  /** The rows' rule, read once here and handed to each face as a boolean. */
  const holdsFloor = (floor: Role): boolean => holds(principal(), floor);
  const boardShown = createMemo(() => showsBoard(props.door, who()));
  let ambientRoot: (() => void) | undefined;
  onCleanup(() => ambientRoot?.());
  createEffect(() => {
    // THE MONITOR FOLLOWS THE BOARD, BOTH WAYS. Its subscriptions belong to a
    // page that can see runs: built before the door is known they are refused
    // on every accept, and left standing when the board hides they keep
    // receiving frames nobody draws. A detachable owner is what lets it go.
    if (boardShown() && ambient() === null) {
      createRoot((dispose) => {
        ambientRoot = dispose;
        setAmbient(ciAmbient(props.client));
      });
      return;
    }
    if (!boardShown() && ambient() !== null) {
      ambientRoot?.();
      ambientRoot = undefined;
      setAmbient(null);
    }
  });

  // ── the cache's route slice ──
  //
  // Two facts about ONE route, read where the switch needs them: whether the
  // page is the cache at all, and which bucket it names. A `Match` narrows
  // nothing into its children, so the readings are memos rather than a
  // discriminated `route()` read inside the JSX.
  const atCache = createMemo(() => route().at === "cache");
  const atProfile = createMemo(() => route().at === "profile");
  const openBucket = createMemo<string | null>(() => {
    const here = route();
    return here.at === "cache" ? here.bucket : null;
  });
  const anonymous = createMemo(() => props.door === true && who()?.kind === "anonymous");
  const ciRoute = createMemo<CiRoute>(() => {
    const here = route();
    return here.at === "cache" || here.at === "profile" ? { at: "board" } : here;
  });

  // ── the shell ──
  /** What the connection indicator says, and in which hue — one call, because
   *  the sentence and the colour are two halves of one answer. */
  const wire = createMemo(() => wireText(props.readout));
  return (
    <div
      class="shell"
      // A RUN is read, so it gets the viewport: `.shell-frame` in `styles.css`
      // turns the page into an app frame whose log pane scrolls inside itself.
      // The board is scanned, so it keeps the page's own scroll.
      classList={{ "shell-frame": route().at === "run" }}
    >
      {/* The masthead, and the wire beside it. The wordmark is `logo.svg`'s own
          idea spelled in text — a slate `$` in front of `odu` in bold mono,
          because odu is a shell prompt you attach to — rather than a second
          drawing of the mark: the logo beside the bundle is content-hashed, so
          a view that named it would be naming a URL only the build knows.

          It is a `<span>` and not a link. There is nowhere for it to go that
          this page is not already, and a decorative control at the top of the
          document is one Tab stop between a person and the first thing they
          came here to press. */}
      <header class="topbar">
        <span class="brand">
          <span class="brand-sigil" aria-hidden="true">$</span>
          <span class="brand-name">odu</span>
        </span>
        {/* THE BOARD IS TWO ROWS — runs and cache — and this is the switch
            between them. Two buttons rather than a link list because they are
            two STATES of one page: `aria-pressed` says which, and a person
            arriving with a screen reader hears "Runs, pressed" rather than a
            navigation menu's worth of ceremony. */}
        <nav class="rows" aria-label="board rows" hidden={anonymous()}>
          <Button pressed={!atCache() && !atProfile()} onClick={() => go({ at: "board" })}>
            Runs
          </Button>
          <Button
            pressed={atCache()}
            onClick={() => go({ at: "cache", bucket: null })}
          >
            Cache
          </Button>
        </nav>
        {/* WHO IS SIGNED IN, and the door's two controls. Absent on a daemon
            with no auth row — `who` is never asked there — so today's header is
            exactly what a loopback page shows. */}
        <Show when={who()}>
          {(held) => (
            <SignedInHeader
              who={held()}
              atProfile={atProfile()}
              onProfile={() => go({ at: "profile" })}
            />
          )}
        </Show>
        {/* The words AND the hue come from `./format`'s `CONNECTION`, so the
            shell names no status class of its own: which colour "reconnecting"
            carries is an assignment of meaning, and it belongs in the table
            with the words rather than in a selector list. */}
        <div class={`wire hue-${wire().hue}`} role="status" aria-live="polite">
          {wire().text}
          <Show when={props.readout.needsReload}>
            {/* Through `Button` like every other control: this was a
                hand-spelled `<button>` re-implementing that component's default
                branch exactly, which meant every future change to what a
                control IS — the drawn hint was one — silently skipped it. */}
            <Button onClick={props.onReload}>Reload</Button>
          </Show>
        </div>
      </header>
      {/* THE DOOR, IN FRONT OF THE BOARD. Three states, in the order a page
          meets them: nobody yet (a daemon with a door, and whoami still in
          flight), anonymous (a sign-in form, and nothing else), signed in (the
          board, as it always was). A daemon with NO door never enters the first
          two: this daemon has no door and the board renders at once. */}
      <Show when={props.door === true && who() === null}>
        <p class="hint">checking who you are…</p>
      </Show>
      <Show when={anonymous()}>
        <SignIn />
      </Show>
      <Show when={boardShown()}>
        <Show when={atProfile()}>
          <ProfileFace
            client={props.auth}
            call={(effect) => Effect.runPromise(effect)}
            now={now()}
            who={who() ?? { kind: "local" }}
            onClose={() => go({ at: "board" })}
          />
        </Show>
        {/* ONE FACE AT A TIME, and each is BUILT ON ENTRY: the compiler turns a
            `Show`'s children into a getter, so leaving a run and coming back
            mints a fresh view rather than re-inserting the one that was disposed
            on the way out — see `@odu/ci/face`'s `dom` header for the failure
            that taught us to care. */}
        <Show when={atCache()}>
          <CacheFace
            client={props.cache}
            bucket={openBucket()}
            canAdminister={holdsFloor("admin")}
            now={now()}
            call={(effect) => Effect.runPromise(effect)}
            onOpen={(bucket) => go({ at: "cache", bucket })}
          />
        </Show>
        <Show when={!atCache() && !atProfile() ? ambient() : null}>
          {(held) => (
            <CiFace
              client={props.client}
              route={ciRoute()}
              now={now()}
              call={(effect) => Effect.runPromise(effect)}
              onRoute={(next) => go(next)}
              ambient={held()}
              canRun={holdsFloor("member")}
              connecting={props.readout.status === "connecting"}
            />
          )}
        </Show>
      </Show>
    </div>
  );
}
