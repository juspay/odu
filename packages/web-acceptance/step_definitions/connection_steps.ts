import { When } from "@cucumber/cucumber";
import type { OduWorld } from "../support/world.ts";

When("the browser goes offline", async function (this: OduWorld) {
  await this.context.setOffline(true);
});

When("the browser comes back online", async function (this: OduWorld) {
  await this.context.setOffline(false);
});

When("the node writes on while the browser is offline", async function (this: OduWorld) {
  await new Promise((resolve) => setTimeout(resolve, 8_000));
});
