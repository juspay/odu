import type { SurfaceReadout } from "@kolu/surface/solid";
import {
  CiFace,
  ciAmbient,
  type CiAmbient,
  type CiClient,
  type CiRoute,
} from "@odu/ci/face";
import { CacheFace, type CacheClient } from "@odu/cache/face";
import { BucketRoute, TunnelFace, type CloudflareClient } from "@odu/cloudflare/face";
import { LOCAL_OWNER, may, type Principal, type Role } from "@odu/cordis/principal";
import {
  PeopleFace,
  ProfileFace,
  SignIn,
  SignedInHeader,
  type AuthClient,
  type Who,
} from "@odu/auth/face";
import { ThemeToggle } from "@odu/face/theme";
import { Button } from "@odu/face/ui";

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
import { faviconSvg, wireText } from "./format";

type Route =
  | CiRoute
  | { at: "cache"; bucket: string | null }
  | { at: "tunnel" }
  | { at: "profile" }
  | { at: "people" };

export type DoorState = boolean | null;

export function principalOf(door: DoorState, who: Who | null): Principal | null {
  if (door === false) return LOCAL_OWNER;
  if (door === null) return null;
  return who === null || who.kind === "anonymous" ? null : who;
}

export function holds(principal: Principal | null, floor: Role): boolean {
  return principal !== null && may(principal, floor);
}

export function doorAfterAnswer(known: DoorState, answer: DoorState): DoorState {
  return answer === null ? known : answer;
}

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
  if (rest === "machines") return { at: "machines" };
  if (rest === "maintain") return { at: "maintain" };
  if (rest === "tunnel") return { at: "tunnel" };
  if (rest === "profile") return { at: "profile" };
  if (rest === "people") return { at: "people" };
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
    case "machines":
      return "#/machines";
    case "maintain":
      return "#/maintain";
    case "profile":
      return "#/profile";
    case "people":
      return "#/people";
    case "run":
      return route.log === null ? runHash(route.runId) : logHash(route.log);
    case "cache":
      return route.bucket === null ? "#/cache" : `#/cache/${encodeURIComponent(route.bucket)}`;
    case "tunnel":
      return "#/tunnel";
  }
}

export function App(props: {
  client: CiClient;
  redialDoor: () => void;
  cache: CacheClient;
  auth: AuthClient;
  cloudflare: CloudflareClient;
  door: DoorState;
  rows: ReadonlyArray<string>;
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

  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(clock));

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
          : (restingIcon ?? link.href);
  });

  const [who, setWho] = createSignal<Who | null>(null);

  const service = props.client.cells.service.use();

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
    void Effect.runPromise(props.auth.procedures.user.whoami()).then(
      (answer) => setWho(answer.who),
      () => {},
    );
  });
  const principal = createMemo(() => principalOf(props.door, who()));
  const holdsFloor = (floor: Role): boolean => holds(principal(), floor);
  const boardShown = createMemo(() => showsBoard(props.door, who()));
  let ambientRoot: (() => void) | undefined;
  onCleanup(() => ambientRoot?.());
  createEffect(() => {
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

  // A `Match` narrows nothing into its children, so the readings the rail and
  // the switch need are memos rather than a discriminated `route()` read
  // inside the JSX.
  const atCache = createMemo(() => route().at === "cache");
  const atTunnel = createMemo(() => route().at === "tunnel");
  const atProfile = createMemo(() => route().at === "profile");
  const atPeople = createMemo(() => route().at === "people");
  const atMachines = createMemo(() => route().at === "machines");
  const tunnelRow = createMemo(() => props.rows.includes("cloudflare"));
  const canGrant = createMemo(() => who()?.kind === "user" && holdsFloor("owner"));
  const openBucket = createMemo<string | null>(() => {
    const here = route();
    return here.at === "cache" ? here.bucket : null;
  });
  const anonymous = createMemo(() => props.door === true && who()?.kind === "anonymous");
  const ciRoute = createMemo<CiRoute>(() => {
    const here = route();
    return here.at === "cache" || here.at === "tunnel" || here.at === "profile" || here.at === "people"
      ? { at: "board" }
      : here;
  });
  const atRuns = createMemo(
    () => !atCache() && !atTunnel() && !atProfile() && !atPeople(),
  );

  const wire = createMemo(() => wireText(props.readout));

  const runsCount = createMemo<{ text: string; hue: string } | null>(() => {
    const held = ambient();
    if (held === null) return null;
    const { failing, active } = held.tally();
    if (failing > 0) return { text: `${failing} failing`, hue: "red" };
    if (active > 0) return { text: `${active} running`, hue: "amber" };
    return null;
  });

  const RailRow = (rail: {
    label: string;
    pressed: boolean;
    count?: { text: string; hue: string } | null;
    onPick: () => void;
  }): JSX.Element => (
    <button type="button" class="nav-item" aria-pressed={rail.pressed} onClick={rail.onPick}>
      <span>{rail.label}</span>
      <Show when={rail.count}>
        {(count) => <span class={`nav-count hue-${count().hue}`}>{count().text}</span>}
      </Show>
    </button>
  );

  return (
    <Show when={!anonymous()} fallback={<SignIn />}>
      <div class="app" classList={{ "app-frame": route().at === "run" }}>
        <aside class="sidebar" aria-label="odu">
          <div class="sidebar-head">
            <span class="brand">
              <span class="brand-name">odu</span>
            </span>
            <div class={`wire hue-${wire().hue}`} role="status" aria-live="polite">
              {wire().text}
            </div>
          </div>
          <Show when={props.readout.needsReload}>
            <Button onClick={props.onReload}>Reload</Button>
          </Show>
          <Show when={boardShown()}>
            <nav class="nav" aria-label="board rows">
              <RailRow
                label="Runs"
                pressed={atRuns() && !atMachines()}
                count={runsCount()}
                onPick={() => go({ at: "board" })}
              />
              <RailRow
                label="Cache"
                pressed={atCache()}
                onPick={() => go({ at: "cache", bucket: null })}
              />
              <RailRow
                label="Machines"
                pressed={atMachines()}
                onPick={() => go({ at: "machines" })}
              />
              <Show when={tunnelRow()}>
                <RailRow
                  label="Tunnel"
                  pressed={atTunnel()}
                  onPick={() => go({ at: "tunnel" })}
                />
              </Show>
              <Show when={canGrant()}>
                <RailRow
                  label="People"
                  pressed={atPeople()}
                  onPick={() => go({ at: "people" })}
                />
              </Show>
            </nav>
          </Show>
          <Show
            when={who()}
            fallback={
              <div class="whoami">
                <span class="avatar" aria-hidden="true">$</span>
                <span class="whoami-who">
                  <span class="whoami-name account-name">
                    {props.door === false ? "local owner" : "signing in…"}
                  </span>
                  <span class="whoami-role">
                    {props.door === false ? "this machine" : ""}
                  </span>
                </span>
              </div>
            }
          >
            {(held) => (
              <SignedInHeader
                who={held()}
                atProfile={atProfile()}
                onProfile={() => go({ at: "profile" })}
              />
            )}
          </Show>
          <ThemeToggle />
        </aside>

        <main class="main">
          <Show when={props.door === true && who() === null}>
            <p class="hint">checking who you are…</p>
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
            <Show when={atPeople() && canGrant()}>
              <PeopleFace
                client={props.auth}
                call={(effect) => Effect.runPromise(effect)}
                now={now()}
                onClose={() => go({ at: "board" })}
              />
            </Show>
            <Show when={atTunnel() && tunnelRow()}>
              <TunnelFace
                client={props.cloudflare}
                now={now()}
                call={(effect) => Effect.runPromise(effect)}
              />
            </Show>
            <Show when={atCache()}>
              <CacheFace
                client={props.cache}
                bucket={openBucket()}
                pushActionRef={() => service.value()?.build.commit ?? null}
                runHref={runHash}
                canAdminister={holdsFloor("admin")}
                local={principal()?.kind === "local"}
                tunnelRow={tunnelRow()}
                now={now()}
                call={(effect) => Effect.runPromise(effect)}
                onOpen={(bucket) => go({ at: "cache", bucket })}
              />
              <Show when={tunnelRow() ? openBucket() : null}>
                {(bucket) => (
                  <BucketRoute client={props.cloudflare} bucket={bucket()} now={now()} />
                )}
              </Show>
            </Show>
            <Show when={atRuns() ? ambient() : null}>
              {(held) => (
                <CiFace
                  client={props.client}
                  route={ciRoute()}
                  now={now()}
                  call={(effect) => Effect.runPromise(effect)}
                  onRoute={(next) => go(next)}
                  bucketHref={(bucket) => hashOf({ at: "cache", bucket })}
                  ambient={held()}
                  canRun={holdsFloor("member")}
                  canAdminister={holdsFloor("admin")}
                  connecting={props.readout.status === "connecting"}
                />
              )}
            </Show>
          </Show>
        </main>
      </div>
    </Show>
  );
}
