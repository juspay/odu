import { dirname, join } from "node:path";
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { RUN_FILES } from "@odu/run-history/paths";
import { type CatalogOptions, handleFor } from "@odu/run-history/store";

export interface PushTokenHandoff {
  path: (runId: string, catalog?: CatalogOptions) => string;
  write: (runId: string, catalog: CatalogOptions, token: string) => void;
  take: (runId: string | undefined, catalog?: CatalogOptions) => string | null;
  drop: (runId: string, catalog?: CatalogOptions) => void;
}

const pathOf = (runId: string, catalog: CatalogOptions = {}): string =>
  join(handleFor(runId, catalog).dir, RUN_FILES.pushToken);

export const pushTokenHandoff: PushTokenHandoff = {
  path: pathOf,
  write: (runId, catalog, token) => {
    const tokenPath = pathOf(runId, catalog);
    mkdirSync(dirname(tokenPath), { recursive: true });
    rmSync(tokenPath, { force: true });
    const handle = openSync(
      tokenPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(handle, token);
    } finally {
      closeSync(handle);
    }
  },
  take: (runId, catalog = {}) => {
    if (runId === undefined) return null;
    const tokenPath = pathOf(runId, catalog);
    try {
      const token = readFileSync(tokenPath, "utf-8").trim();
      rmSync(tokenPath, { force: true });
      return token === "" ? null : token;
    } catch {
      return null;
    }
  },
  drop: (runId, catalog = {}) => {
    rmSync(pathOf(runId, catalog), { force: true });
  },
};
