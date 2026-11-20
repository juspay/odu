import { createHash } from "node:crypto";
import { join } from "node:path";
import type { SurfaceDispatch } from "@kolu/surface/link";
import { unixSocketLink } from "@kolu/surface/links/unix-socket";
import type { WireLink } from "@kolu/surface/links/wire";
import { resolveDaemonHome } from "@kolu/surface-daemon";
// The dial's compat shim: a unix-path `connect(2)` that fails outright may emit
// its error SYNCHRONOUSLY under Bun, before any caller's listener exists — see
// the module. It ships with `@odu/run-client`'s dial, and a second dial on the
// same socket class needs it for the same reason.
import "@odu/run-client/asyncConnectError";
import { isNobodyServing } from "@odu/run-client/dial";
import { stateRoot } from "@odu/run-history/paths";
import { Effect } from "effect";
import { readServiceCell } from "./dial";
import { DEFAULT_SERVICE_ORIGIN, SERVICE_APP, serviceOrigin } from "./endpoint";
import {
  admitService,
  CI_NEEDS,
  handshakeTimedOut,
  oduServiceClientOver,
  type OduServiceClient,
  oduServiceSurface,
  SERVICE_HANDSHAKE_MS,
  type ServiceAdmission,
  type ServiceRefusal,
} from "./surface";

/** ONE GATE PER ADDRESS — the namespace a daemon home is derived from. */
export function webAppNamespace(origin: string): string {
  if (origin === DEFAULT_SERVICE_ORIGIN) return SERVICE_APP;
  const digest = createHash("sha256").update(origin).digest("hex").slice(0, 12);
  return `${SERVICE_APP}-${digest}`;
}

function socketPathUnder(
  app: string,
  env: Record<string, string | undefined>,
): string {
  return join(stateRoot(env), app, `${app}.sock`);
}

/**
 * WHERE THE DAEMON'S HOME IS — the one answer, for the daemon and for every
 * client that has to dial it.
 */
export function webHomeOptions(
  origin: string,
  env: Record<string, string | undefined> = process.env,
): { app: string; placement: "state"; socketOverride?: string } {
  const app = webAppNamespace(origin);
  const explicit = env.ODU_STATE_DIR?.trim();
  if (explicit === undefined || explicit === "") {
    return { app, placement: "state" };
  }
  return { app, placement: "state", socketOverride: socketPathUnder(app, env) };
}

/**
 * The socket the service serves on for `origin` — PURE path algebra.
 *
 * A path it returns is a live service only if {@link dialServiceSocket} says so.
 */
export function serviceSocketPath(
  origin: string = serviceOrigin(),
  env: Record<string, string | undefined> = process.env,
): string {
  return resolveDaemonHome(webHomeOptions(origin, env)).socketPath;
}

/** A service dialled over its socket, addressed by PATH rather than by URL. */
export interface ServiceSocketConnection extends AsyncDisposable {
  client: OduServiceClient;
  /** The transport-neutral dispatch under {@link ServiceSocketConnection.client}. */
  dispatch: SurfaceDispatch;
  /** The socket path that was dialled, for an error message that has to name it. */
  socketPath: string;
}

/**
 * Nobody is serving that socket, a service this build cannot speak to, or a
 * live one — three answers, and the dial is where they are told apart.
 */
export type ServiceSocketDial =
  | { kind: "absent"; socketPath: string }
  | ({ kind: "refused"; socketPath: string } & ServiceRefusal)
  | ({ kind: "connected" } & ServiceSocketConnection);

/**
 * Dial the service's unix socket, and adopt only a service this build can read.
 *
 * Answers `{ kind: "absent" }` when nothing is serving the path — the ordinary
 * state of a machine that has never run `odu web` — `{ kind: "refused" }` for a
 * daemon whose contract this build cannot speak, and THROWS for everything
 * else: a permission error on a socket somebody IS serving, a path that is not
 * a socket at all, or a link that connected and then could not speak the wire.
 *
 * It does NOT start the service.
 */
export async function dialServiceSocket(
  origin: string = serviceOrigin(),
  opts: { handshakeMs?: number } = {},
): Promise<ServiceSocketDial> {
  const handshakeMs = opts.handshakeMs ?? SERVICE_HANDSHAKE_MS;
  const socketPath = serviceSocketPath(origin);
  let link: WireLink;
  try {
    link = await unixSocketLink({
      group: oduServiceSurface.group,
      socketPath,
    });
  } catch (err) {
    if (isNobodyServing(err)) return { kind: "absent", socketPath };
    throw err;
  }
  const client = oduServiceClientOver(link.dispatch);
  let verdict: ServiceAdmission;
  try {
    verdict = admitService(
      await Effect.runPromise(
        Effect.timeoutOrElse(readServiceCell(client), {
          duration: handshakeMs,
          orElse: () =>
            Effect.fail(new Error(handshakeTimedOut(socketPath, handshakeMs))),
        }),
      ),
      socketPath,
      CI_NEEDS,
    );
  } catch (err) {
    await link.dispose();
    throw err;
  }
  if (verdict.kind === "refuse") {
    await link.dispose();
    return { ...verdict, kind: "refused", socketPath };
  }
  return {
    kind: "connected",
    socketPath,
    client,
    dispatch: link.dispatch,
    [Symbol.asyncDispose]: () => link.dispose(),
  };
}
