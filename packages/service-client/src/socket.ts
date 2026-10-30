/**
 * The service's LOCAL half: where its socket is, and how a local face reaches it.
 *
 * `./endpoint` answers "where is the service" for the faces that speak its
 * websocket — a browser, the CLI, the MCP bridge — and it is browser-safe
 * because a URL and a string operation are all it needs. This module answers
 * the same question for the faces that are ON the machine: the daemon binds a
 * unix socket in its home, and anything local enough to share that home should
 * reach it over the socket rather than over a port.
 *
 * WHY IT IS ONE MODULE AND NOT TWO FACTS. The address and the way in are the
 * same fact about one daemon, and they have to be computed the same way: the
 * socket lives in the home the daemon DERIVED ITS NAME FROM, so a client that
 * re-derived the name from the origin would be one rename away from dialling a
 * socket nobody bound. {@link webAppNamespace} is that derivation, and it moved
 * here from `@odu/cli`'s launcher so the launcher and every local client read
 * it from one place — the CLI imports it back for the gate and the spawn.
 *
 * WHY THE PACKAGE'S BROWSER-SAFE CLAIM SURVIVES IT. This module is `node:`
 * through and through (`node:crypto` for the namespace digest, the socket
 * link, the daemon-home algebra), and it is DECLARED as the one node-only
 * module in `./closure.test.ts` rather than left to be discovered: every other
 * module here must stay importable by a browser tab, and no module outside that
 * declared set may reach this one.
 */

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
  handshakeTimedOut,
  oduServiceClientOver,
  type OduServiceClient,
  oduServiceSurface,
  SERVICE_HANDSHAKE_MS,
  type ServiceAdmission,
} from "./surface";

/**
 * ONE GATE PER ADDRESS — the namespace a daemon home is derived from.
 *
 * `ODU_WEB_ORIGIN` is documented as moving the whole service, so a developer
 * can run a second odu against a scratch catalog. It moved the address and not
 * the gate: both services computed `~/.local/state/odu-web/`, so the second one
 * read a live holder there and yielded — to a daemon serving a different port
 * and a different catalog. A singleton is per-address or it is not a singleton,
 * and the two spellings of "which service am I" have to be one.
 *
 * The default origin keeps the plain namespace, so nothing about an ordinary
 * install moves. Any other origin gets its own, named by a digest of the origin
 * rather than by the port alone — `http://127.0.0.1:9000` and `http://[::1]:9000`
 * are two addresses.
 *
 * It lives HERE rather than in the launcher that used to own it, because the
 * launcher is not the only thing that has to agree about it: the socket a local
 * client dials is inside this home, so the client and the daemon must derive the
 * name from the same function or a client will dial a path nobody bound.
 */
export function webAppNamespace(origin: string): string {
  if (origin === DEFAULT_SERVICE_ORIGIN) return SERVICE_APP;
  const digest = createHash("sha256").update(origin).digest("hex").slice(0, 12);
  return `${SERVICE_APP}-${digest}`;
}

/**
 * WHERE THE DAEMON'S HOME IS — the one answer, for the daemon and for every
 * client that has to dial it.
 *
 * kolu derives a home from `$HOME` (`~/.local/state/<app>`) and nothing else,
 * because `$XDG_STATE_HOME` varies by launch context while `$HOME` does not. A
 * container has neither: a busybox rootfs with a read-only store and an empty
 * `$HOME` can write nowhere the daemon needs. odu already has the explicit,
 * stable knob for this — `$ODU_STATE_DIR`, which the run catalog and the cache
 * both honour — so a home under it is what makes the whole process's state one
 * directory, and kolu's `socketOverride` is the seam for it: it puts the socket
 * where it is told and the gate BESIDE it, skipping placement entirely.
 *
 * `$XDG_STATE_HOME` is deliberately NOT honoured here. kolu's reasoning stands
 * (a home that moves with the launch context splits one daemon's identity), and
 * `$ODU_STATE_DIR` is the deliberate spelling of the same intent.
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
  // `${app}.sock`, not a fixed name: two origins sharing one state directory
  // already get two namespaces, and a fixed socket name would put them back on
  // one path — the collision `webAppNamespace` exists to prevent.
  return { app, placement: "state", socketOverride: join(stateRoot(env), app, `${app}.sock`) };
}

/**
 * The socket the service serves on for `origin` — PURE path algebra, and the
 * purity is the point: a client asking where a daemon would be must not bring
 * one into being, so this goes through `resolveDaemonHome` (which creates
 * nothing) rather than `daemonHome` (which makes the directory, verifies it is
 * private, and would have a CLIENT creating a DAEMON's home).
 *
 * A path it returns is a live service only if {@link dialServiceSocket} says so.
 */
export function serviceSocketPath(
  origin: string = serviceOrigin(),
  env: Record<string, string | undefined> = process.env,
): string {
  return resolveDaemonHome(webHomeOptions(origin, env)).socketPath;
}

/** A service dialled over its socket: the same face and the same teardown
 *  obligation as a websocket connection, addressed by PATH rather than by URL. */
export interface ServiceSocketConnection {
  client: OduServiceClient;
  /** The transport-neutral dispatch under {@link ServiceSocketConnection.client}
   *  — see `ServiceConnection.dispatch` for why a face may need it. */
  dispatch: SurfaceDispatch;
  /** The socket path that was dialled, for an error message that has to name it. */
  socketPath: string;
  /** Not optional bookkeeping: the link holds the dial, ping and response
   *  fibers, and dropping it leaks all three. */
  dispose: () => Promise<void>;
}

/**
 * Nobody is serving that socket, a service this build cannot speak to, or a
 * live one — three answers, and the dial is where they are told apart.
 *
 * ABSENCE IS A VALUE here, unlike {@link dialService}'s rejection, and the
 * difference is not a style choice: a websocket dial cannot tell "nothing is
 * listening" from "something is listening that is not ours" — both are a
 * connection that never opens — while a unix-path `connect(2)` can, and says so
 * with ENOENT/ECONNREFUSED. A face that renders "no odu on this machine" as an
 * ordinary state (kolu's Inspector draws no chip at all) must be able to receive
 * it as one, and a face that got it wrong would be showing an error about a
 * machine where odu was never installed.
 *
 * A REFUSAL is the opposite fact, and carrying it as a third arm is why the
 * handshake happens HERE: a daemon that answers and speaks a contract this
 * build cannot read is a loud condition — an install to go and look at, never a
 * blank — and every consumer that had to compare versions itself was a second
 * judge of a comparison with a direction that is easy to get backwards
 * ({@link admitService}).
 */
export type ServiceSocketDial =
  | { kind: "absent"; socketPath: string }
  | ({ kind: "refused"; socketPath: string } & Omit<
      Extract<ServiceAdmission, { kind: "refuse" }>,
      "kind"
    >)
  | ({ kind: "connected" } & ServiceSocketConnection);

/**
 * Dial the service's unix socket, and adopt only a service this build can read.
 *
 * Answers `{ kind: "absent" }` when nothing is serving the path — the ordinary
 * state of a machine that has never run `odu web` — `{ kind: "refused" }` for a
 * daemon whose contract this build cannot speak, and THROWS for everything
 * else: a permission error on a socket somebody IS serving, a path that is not
 * a socket at all, or a link that connected and then could not speak the wire.
 * Those are not absence, and reporting them as absence is how a face comes to
 * say a running odu is not there.
 *
 * The handshake is part of the dial rather than a step after it, so there is no
 * window in which a caller holds a link it has not qualified — the window every
 * consumer used to fill with its own version comparison. A refusal disposes the
 * link before answering: a face that drew the refusal and then had to remember
 * to tear down the connection behind it would leak the dial, ping and response
 * fibers on exactly the path nobody exercises.
 *
 * It does NOT start the service. Bootstrapping is `odu web`'s job and only
 * `odu web`'s — a face that silently spawned a daemon would make every mistyped
 * invocation a reason to start a second one.
 *
 * THE HANDSHAKE IS BOUNDED. A daemon can accept the socket and then publish
 * nothing — juspay/odu#113's wedged refresh loop is exactly that — and an
 * unbounded read of its cell turns the three-way answer above into no answer at
 * all: the caller waits on a promise nothing will settle. The deadline
 * INTERRUPTS the read rather than racing a timer beside it, so the link is
 * disposed with no fiber still listening for a frame that is not coming.
 * `handshakeMs` exists for tests, which cannot wait ten seconds to prove it.
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
    );
  } catch (err) {
    // A link nobody will use still holds the dial, ping and response fibers.
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
    dispose: () => link.dispose(),
  };
}
