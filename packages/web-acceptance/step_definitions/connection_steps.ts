/**
 * Cutting the wire and putting it back.
 *
 * `context.setOffline` drops the socket and leaves the SERVICE alive, which is
 * the half of the connection story that can be watched coming back. It is the
 * only way to reach `reconnecting` deliberately: killing the daemon instead
 * would retire the page (a different, terminal state) and there would be nothing
 * to recover to.
 *
 * The waits here are deliberately patient. The framework's liveness watchdog has
 * a timeout of its own, so the indicator does not flip on the same tick the
 * socket dies — and a step that asserted immediately after toggling would be
 * reporting the watchdog's period as a UI flake.
 */

import { When } from "@cucumber/cucumber";
import type { OduWorld } from "../support/world.ts";

When("the browser goes offline", async function (this: OduWorld) {
  await this.context.setOffline(true);
});

When("the browser comes back online", async function (this: OduWorld) {
  await this.context.setOffline(false);
});
