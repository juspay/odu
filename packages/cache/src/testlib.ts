import { join } from "node:path";
import { objectStores } from "./stores";

export const asRoot = (rootToken: string) => ({
  authority: { kind: "root" as const, rootToken },
});

export const localStores = (stateRoot: string) => objectStores(new Map(), join(stateRoot, "cache"));
