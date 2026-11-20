import { When } from "@cucumber/cucumber";
import type { OduWorld } from "../support/world.ts";

const OUTLAST_ONE_WAITING_READ_MS = 8_000;

When("the browser goes offline", async function (this: OduWorld) {
  await this.context.setOffline(true);
});

When("the browser comes back online", async function (this: OduWorld) {
  await this.context.setOffline(false);
});

When("the node writes on while the browser is offline", async function (this: OduWorld) {
  await new Promise((resolve) => setTimeout(resolve, OUTLAST_ONE_WAITING_READ_MS));
});
