/**
 * The browser's entry point — dial, render, and nothing else.
 *
 * `connectSurfaces` is one call for the socket, the link, the clients and the
 * liveness watchdog, and it derives its URL from the page's own origin. THE
 * BOARD IS TWO ROWS: the runs are the wire's unprefixed CORE and the cache is
 * served beside them as a sibling, so this is the rooted-bundle form — one
 * dial, a typed client per row, one health fold. The two things this file
 * supplies are the two the framework cannot decide:
 *
 *   - **`retired`** — what a tab does when the service it came from is gone.
 *     Required, with no default, so a page that compiles has an answer. A
 *     reload is the right one here: the wire will never dial again, and the
 *     shell is `no-store`, so the reload lands on whatever build is serving now.
 *   - **The fault look** — what an uncaught render throw looks like. The
 *     framework catches it and prints it; the markup is ours. Without one, a
 *     throw is a white tab.
 */

import { reloadForUpdate } from "@kolu/surface-app/lifecycle";
import { connectSurfaces } from "@kolu/surface-app/solid";
import { AUTH_KEY, oduAuthSurface } from "@odu/auth/surface";
import { CACHE_KEY, oduCacheSurface } from "@odu/cache/surface";
import { SERVICE_DOOR_PATH } from "@odu/cordis/services";
import { oduServiceSurface } from "@odu/service-client/surface";
import { render } from "solid-js/web";
import { App } from "./app";

const root = document.getElementById("odu");
if (root === null) {
  throw new Error("odu: the shell has no #odu element to render into");
}

/**
 * DOES THIS SERVER HAVE A DOOR? Asked of the HOST, once, before anything is
 * drawn.
 *
 * It used to ride the runs' service cell, which meant the shell opened the
 * board and subscribed to `runs` before it knew the answer — on a server with a
 * door, every one of those subscriptions is refused. The fact is the host's
 * (it changes with `auth`, not with the runs), so the host answers it on its own
 * route, and a page that gets the answer first never draws the wrong board.
 * An unreachable answer is `null` — UNKNOWN, not "no door". A page that assumed
 * a loopback daemon would draw every run control for a server that never
 * answered; the wire indicator is the honest state, and nothing privileged is
 * drawn until the question has an answer.
 */
async function doorMounted(): Promise<boolean | null> {
  try {
    // A `cache-control` header rather than fetch's cache option: the fence
    // refuses a sibling key spelled with the row's word in any face, and a
    // request option that happens to share a row's name is not a composition.
    const response = await fetch(SERVICE_DOOR_PATH, {
      headers: { "cache-control": "no-cache" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { door?: unknown };
    return body.door === true;
  } catch {
    return null;
  }
}

const door = await doorMounted();

const connection = await connectSurfaces({
  // The rows. `cache` and `auth` are the keys the daemon mounts those rows at,
  // so the clients this bundle hands back address `surface/cache/…` and
  // `surface/auth/…` without a second dial. The auth row may not be mounted at
  // all — the service cell says so, and until it does nothing asks who you are.
  surfaces: { [CACHE_KEY]: oduCacheSurface, [AUTH_KEY]: oduAuthSurface },
  core: { surface: oduServiceSurface, name: "ci" },
  retired: reloadForUpdate,
});

render(
  () => (
    <div class="root">
      <App
        client={connection.core}
        cache={connection.clients.cache}
        auth={connection.clients.auth}
        door={door}
        // The framework's readout is an accessor; read HERE, inside the render
        // root, so the compiler makes it a getter on `App`'s props and the
        // indicator keeps moving. Reading it into a `const` would freeze the
        // page on whatever the connection happened to be at boot.
        readout={connection.readout()}
        onReload={reloadForUpdate}
      />
    </div>
  ),
  root,
);
