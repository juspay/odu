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

/**
 * STAY offline while the producer keeps going.
 *
 * Going offline and straight back is not an outage — it may not even catch a
 * read in flight. What has to happen is that the follow's read FAILS while the
 * node writes on, so coming back has bytes to catch up on. Long enough to
 * outlast one waiting read, which is what a follower is doing when it is
 * caught up.
 */
When("the node writes on while the browser is offline", async function (this: OduWorld) {
  await new Promise((resolve) => setTimeout(resolve, 8_000));
});
