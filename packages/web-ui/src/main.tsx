import { reloadForUpdate } from "@kolu/surface-app/lifecycle";
import { connectSurfaces } from "@kolu/surface-app/solid";
import { AUTH_KEY, oduAuthSurface } from "@odu/auth/surface";
import { CACHE_KEY, oduCacheSurface } from "@odu/cache/surface";
import { CLOUDFLARE_KEY, oduCloudflareSurface } from "@odu/cloudflare/surface";
import { readDoor, readRows } from "@odu/cordis/services";
import { oduServiceSurface } from "@odu/service-client/surface";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { App, doorAfterAnswer, doorStateOf, type DoorState } from "./app";

const root = document.getElementById("odu");
if (root === null) {
  throw new Error("odu: the shell has no #odu element to render into");
}

const [door, setDoor] = createSignal<DoorState>(
  doorStateOf(await readDoor(window.location.origin)),
);

const rows = (await readRows(window.location.origin)) ?? [];

const connection = await connectSurfaces({
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
        rows={rows}
        redialDoor={() => {
          void readDoor(window.location.origin).then((answer) => {
            setDoor((known) => doorAfterAnswer(known, doorStateOf(answer)));
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
