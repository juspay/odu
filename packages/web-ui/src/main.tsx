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
import { oduCacheSurface } from "@odu/cache/surface";
import { oduServiceSurface } from "@odu/service-client/surface";
import { render } from "solid-js/web";
import { App } from "./app";

const root = document.getElementById("odu");
if (root === null) {
  throw new Error("odu: the shell has no #odu element to render into");
}

const connection = await connectSurfaces({
  // The rows. `cache` is the key the daemon mounts that row at, so the client
  // this bundle hands back addresses `surface/cache/…` without a second dial.
  surfaces: { cache: oduCacheSurface },
  core: { surface: oduServiceSurface, name: "ci" },
  retired: reloadForUpdate,
});

render(
  () => (
    <div class="root">
      <App
        client={connection.core}
        cache={connection.clients.cache}
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
