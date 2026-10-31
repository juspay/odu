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
import { CLOUDFLARE_KEY, oduCloudflareSurface } from "@odu/cloudflare/surface";
import { readDoor } from "@odu/cordis/services";
import { oduServiceSurface } from "@odu/service-client/surface";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { App, doorAfterAnswer, type DoorState } from "./app";

const root = document.getElementById("odu");
if (root === null) {
  throw new Error("odu: the shell has no #odu element to render into");
}

/**
 * DOES THIS SERVER HAVE A DOOR? Asked of the HOST before anything is drawn, and
 * asked again whenever the shell sees the wire come alive.
 *
 * The question itself is `@odu/cordis/services`'s `readDoor` — the same one the
 * CLI's MCP bridge asks, so the page and an agent cannot disagree about which
 * board a daemon serves. An unreachable answer is `null`: UNKNOWN, not "no
 * door", and a known door survives a failed re-ask (`doorAfterAnswer`).
 */
const [door, setDoor] = createSignal<DoorState>(await readDoor(window.location.origin));

const connection = await connectSurfaces({
  // The rows. `cache` and `auth` are the keys the daemon mounts those rows at,
  // so the clients this bundle hands back address `surface/cache/…` and
  // `surface/auth/…` without a second dial. The auth row may not be mounted at
  // all — the service cell says so, and until it does nothing asks who you are.
  surfaces: {
    [CACHE_KEY]: oduCacheSurface,
    [AUTH_KEY]: oduAuthSurface,
    [CLOUDFLARE_KEY]: oduCloudflareSurface,
  },
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
        cloudflare={connection.clients.cloudflare}
        door={door()}
        // The shell decides WHEN (a live wire); this file answers HOW (a host
        // route, which the fence keeps out of every other file).
        redialDoor={() => {
          // A failed re-ask keeps the door the page already knows: an
          // unreachable host is the wire indicator's news, not a reason to
          // take the board away.
          void readDoor(window.location.origin).then((answer) => {
            setDoor((known) => doorAfterAnswer(known, answer));
          });
        }}
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
