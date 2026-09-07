/**
 * THE SHELL — routing, the connection indicator, and the one place a view meets
 * the wire.
 *
 * Everything reactive is bound here and handed to the views as accessors, so a
 * view holds no client and cannot invent a second way to reach the service.
 * That is not tidiness: it is what makes "the browser has no execution or retry
 * logic of its own" a thing you can check by reading one file.
 *
 * **The connection is drawn, not hidden.** `readout()` is the framework's own
 * five-state fact — connecting, live, degraded, reconnecting, retired — and
 * each is a state a person can be in and needs to know about. `reconnecting`
 * in particular is the honest one: the page keeps showing the last thing the
 * service said, and it says so rather than letting stale rows look live.
 *
 * **A procedure call runs at the UI edge.** Every control is an `Effect`, and
 * `Effect.runPromise` here is that edge — the one place this app crosses from
 * description to execution, so a control's whole story (pending → receipt or
 * refusal) is in one function rather than scattered per button.
 */

import type { SurfaceClient } from "@kolu/surface/solid";
import type { SurfaceReadout } from "@kolu/surface/solid";
import { formatLogKey, parseLogKey } from "@odu/service-client/logKey";
import type { oduServiceSurface } from "@odu/service-client/surface";
import { Effect } from "effect";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { board } from "./board";
import { create, type CreateState, type StartForm } from "./create";
import { type ControlState, detail } from "./detail";
import { el, type View } from "./dom";
import { CONNECTION } from "./format";
import type { LogTail, NodesFrame, RunNode, RunRow } from "./types";

type ServiceSpec = (typeof oduServiceSurface)["spec"];
type Client = SurfaceClient<ServiceSpec>;

/**
 * Where the page is, in the URL hash.
 *
 * A run — and a NODE's output within it — is linkable: a person pastes the
 * address into a message and whoever opens it is looking at the same failure,
 * not at a board they then have to navigate. That is also why the selected node
 * is part of the route rather than a signal beside it: one source of truth, so
 * Back works through a log the same way it works through a run.
 *
 * `#/run/<id>` · `#/run/<id>/<encoded node>/<attempt>` · `#/new`; anything else
 * is the board. The node/attempt pair is spelled exactly as a LOG KEY, so the
 * address in the URL bar and the address an agent echoes are the same string.
 */
type Route =
  | { at: "board" }
  | { at: "run"; runId: string; log: string | null }
  | { at: "new" };

function routeOf(hash: string): Route {
  const path = hash.replace(/^#\/?/, "");
  if (path === "new") return { at: "new" };
  const run = /^run\/(.+)$/.exec(path);
  if (run?.[1] === undefined) return { at: "board" };
  const parts = run[1].split("/");
  const runId = parts[0];
  if (runId === undefined || runId === "") return { at: "board" };
  // Three segments IS a log key — the same spelling `formatLogKey` mints — so
  // the URL carries the address rather than a second encoding of it.
  return {
    at: "run",
    runId,
    log: parts.length === 3 ? run[1] : null,
  };
}

function hashOf(route: Route): string {
  switch (route.at) {
    case "board":
      return "#/";
    case "new":
      return "#/new";
    case "run":
      return route.log === null ? `#/run/${route.runId}` : `#/run/${route.log}`;
  }
}

/** A request id a repeat of this page's own click cannot duplicate. The service
 *  makes a request id mandatory precisely so a lost reply is reconcilable, and
 *  a browser that reused one would replay its previous answer rather than doing
 *  what the person just asked for. */
function requestId(what: string): string {
  return `web-${what}-${crypto.randomUUID()}`;
}

/** The message a refusal becomes. The service's refusals are already sentences
 *  written for a person; this only adds the recovery when there is one. */
function refusalText(err: unknown): string {
  const value = err as { message?: unknown; suggestion?: unknown };
  const message =
    typeof value?.message === "string" ? value.message : String(err);
  const suggestion = Array.isArray(value?.suggestion)
    ? ` Try: ${(value.suggestion as string[]).join(" ")}`
    : "";
  return `${message}${suggestion}`;
}

export function app(opts: {
  client: Client;
  readout: () => SurfaceReadout;
  onReload: () => void;
}): View {
  const [route, setRoute] = createSignal<Route>(
    routeOf(globalThis.location?.hash ?? ""),
  );
  const go = (next: Route): void => {
    // The hash is the source of truth, so Back works: pushing it fires
    // `hashchange`, which is what actually moves the signal.
    globalThis.location.hash = hashOf(next);
  };
  const onHash = (): void => {
    // A THUNK, not the value: Solid's setter treats a function as an updater,
    // so `setRoute(routeOf(...))` would work while `setRoute(route)` for a
    // route that happens to be callable would not. Wrapping is the spelling
    // that is right whatever the value's shape.
    setRoute(() => routeOf(globalThis.location.hash));
  };
  globalThis.addEventListener("hashchange", onHash);
  onCleanup(() => globalThis.removeEventListener("hashchange", onHash));

  // A clock the ages read. One interval for the whole page rather than one per
  // row, and `unref`-less because a browser has no such notion — `onCleanup`
  // is the disposal that matters here.
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(clock));

  // ── the board ──
  const runs = opts.client.collections.runs.use();
  const rows = createMemo<RunRow[]>(() => {
    const out: RunRow[] = [];
    for (const key of runs.keys()) {
      const row = runs.byKey(key)?.();
      if (row !== undefined) out.push(row);
    }
    // Newest first. Sorted HERE rather than trusted from the wire: under batched
    // delivery `keys()` is arrival order, which the framework's own contract
    // says to treat as a set rather than a list.
    return out.sort((a, b) => b.createdAt - a.createdAt);
  });

  // ── the selected run ──
  const runId = createMemo(() => {
    const at = route();
    return at.at === "run" ? at.runId : null;
  });
  const selectedRun = createMemo<RunRow | undefined>(() => {
    const id = runId();
    return id === null ? undefined : runs.byKey(id)?.();
  });
  const nodesSub = opts.client.streams.nodes.use(() => {
    const id = runId();
    return id === null ? null : { runId: id };
  });
  const frame = createMemo<NodesFrame | undefined>(() => nodesSub());

  // ── the selected node's log ──
  //
  // Derived from the ROUTE, not held beside it. One source of truth means Back
  // moves through logs as well as runs, and a pasted address opens on the same
  // failure the sender was looking at.
  const logKey = createMemo<string | null>(() => {
    const at = route();
    return at.at === "run" ? at.log : null;
  });
  const selected = createMemo<RunNode | null>(() => {
    const key = logKey();
    if (key === null) return null;
    const parsed = parseLogKey(key);
    if (parsed === null) return null;
    return (
      frame()?.nodes.find(
        (node) => node.id === parsed.node && node.attempt === parsed.attempt,
      ) ?? null
    );
  });
  // The whole-log page is cleared whenever the address moves: a panel left
  // showing the previous node's output under a new heading is the worst kind of
  // stale.
  createEffect(() => {
    logKey();
    setPage(null);
  });
  const tails = opts.client.collections.logTails.use({
    keys: () => {
      const key = logKey();
      return key === null ? [] : [key];
    },
  });
  const tail = createMemo<LogTail | undefined>(() => {
    const key = logKey();
    return key === null ? undefined : tails.byKey(key)?.();
  });
  const tailPending = createMemo(() => {
    const key = logKey();
    return key === null ? false : (tails.byKey(key)?.pending() ?? true);
  });
  const tailError = createMemo(() => {
    const key = logKey();
    return key === null ? undefined : tails.byKey(key)?.error();
  });

  // The whole log, on request. Separate from the tail because they answer
  // different questions — see `@odu/service`'s `logs.ts`.
  const [page, setPage] = createSignal<string | null>(null);

  // ── controls ──
  const [control, setControl] = createSignal<ControlState>({ kind: "idle" });
  const [creating, setCreating] = createSignal<CreateState>({ kind: "idle" });

  /** THE UI EDGE: one place a description becomes execution. */
  const run = <A,>(
    what: string,
    effect: Effect.Effect<A, unknown>,
    onOk: (value: A) => string,
  ): void => {
    setControl({ kind: "pending", what });
    void Effect.runPromise(effect).then(
      (value) => setControl({ kind: "ok", message: onOk(value) }),
      (err: unknown) => setControl({ kind: "refused", message: refusalText(err) }),
    );
  };

  const controls = {
    retryNode: (node: string, attempt: number): void => {
      const id = runId();
      if (id === null) return;
      run(
        `retrying ${node}`,
        opts.client.procedures.run.retry({
          runId: id,
          selector: node,
          requestId: requestId("retry"),
          // The optimistic-concurrency guard, carried to the process that can
          // enforce it. A person clicks on a reading of the page; if the node
          // has moved on since that reading, the retry is refused rather than
          // landing on an attempt they never saw.
          expectAttempt: { node, attempt },
        }),
        (receipt) =>
          receipt.mode === "live"
            ? `Reset ${receipt.roots.join(", ")} on this run${
                receipt.resetDependants.length === 0
                  ? ""
                  : ` (and ${receipt.resetDependants.length} dependant${receipt.resetDependants.length === 1 ? "" : "s"})`
              }.`
            : `This run had finished, so odu started a linked replay: ${receipt.effectiveRun}.`,
      );
    },
    cancelRun: (): void => {
      const id = runId();
      if (id === null) return;
      run(
        "cancelling the run",
        opts.client.procedures.run.cancel({
          runId: id,
          scope: { kind: "run" },
          requestId: requestId("cancel"),
        }),
        (result) =>
          result.effective === "nothing"
            ? `Nothing was cancelled — ${result.detail ?? "there was nothing to stop"}.`
            : "Told the coordinator to stop.",
      );
    },
    cancelNode: (node: string): void => {
      const id = runId();
      if (id === null) return;
      run(
        `cancelling ${node}`,
        opts.client.procedures.run.cancel({
          runId: id,
          scope: { kind: "node", node },
          requestId: requestId("cancel-node"),
        }),
        (result) =>
          result.effective === "nothing"
            ? `Nothing was cancelled — ${result.detail ?? "there was nothing to stop"}.`
            : `Stopped ${node}.`,
      );
    },
    cancelLane: (platform: string): void => {
      const id = runId();
      if (id === null) return;
      run(
        `dropping the ${platform} lane`,
        opts.client.procedures.run.cancel({
          runId: id,
          scope: { kind: "lane", platform },
          requestId: requestId("cancel-lane"),
        }),
        (result) =>
          result.effective === "nothing"
            ? `Nothing was cancelled — ${result.detail ?? "there was nothing to stop"}.`
            : `Dropped the ${platform} lane; the rest of the run continues.`,
      );
    },
    runAgain: (): void => {
      const current = selectedRun();
      if (current === undefined) return;
      run(
        "starting a new run",
        opts.client.procedures.run.start({
          checkout: current.repoRoot,
          expectedSha: current.sha,
          requestId: requestId("again"),
          selectors: [...current.scope.selectors],
          platforms: [...current.scope.platforms],
          noDeps: current.scope.noDeps,
        }),
        (receipt) =>
          receipt.accepted
            ? `Started ${receipt.runId}.`
            : `That checkout already has a live run: ${receipt.runId}.`,
      );
    },
  };

  const readFullLog = (): void => {
    const key = logKey();
    if (key === null) return;
    void Effect.runPromise(opts.client.procedures.log.read({ key })).then(
      (answer) => setPage(answer.text),
      (err: unknown) => setControl({ kind: "refused", message: refusalText(err) }),
    );
  };

  const start = (form: StartForm): void => {
    setCreating({ kind: "starting" });
    void Effect.runPromise(
      opts.client.procedures.run.start({
        checkout: form.checkout,
        expectedSha: form.expectedSha,
        requestId: requestId("start"),
        // ABSENT rather than empty: the wire's optional keys mean "not said",
        // and an empty array is a caller asserting a choice they did not make.
        ...(form.selectors.length === 0 ? {} : { selectors: form.selectors }),
        ...(form.platforms.length === 0 ? {} : { platforms: form.platforms }),
        ...(form.hostPins.length === 0 ? {} : { hostPins: form.hostPins }),
        ...(form.noStrict ? { noStrict: true, noSnapshot: true } : {}),
        ...(form.noPost ? { noPost: true } : {}),
        ...(form.supersede ? { supersede: true } : {}),
      }),
    ).then(
      (receipt) => {
        if (receipt.accepted) {
          setCreating({ kind: "started", runId: receipt.runId });
          go({ at: "run", runId: receipt.runId, log: null });
          return;
        }
        setCreating({
          kind: "existing",
          runId: receipt.runId,
          sha: receipt.existing?.sha ?? receipt.sha,
        });
      },
      (err: unknown) =>
        setCreating({ kind: "refused", message: refusalText(err) }),
    );
  };

  // ── the shell ──
  return el(
    "div",
    { class: "shell" },
    el(
      "div",
      {
        class: () => `wire wire-${opts.readout().status}`,
        role: "status",
        "aria-live": "polite",
      },
      () => {
        const readout = opts.readout();
        return readout.status === "degraded"
          ? `${CONNECTION.degraded} — nothing is arriving on ${readout.stopped.join(", ")}`
          : CONNECTION[readout.status];
      },
      el(Show, {
        when: () => opts.readout().needsReload,
        children: el(
          "button",
          { type: "button", class: "btn", onClick: opts.onReload },
          "Reload",
        ),
      }),
    ),
    el(Show, {
      when: () => route().at === "board",
      children: board({
        rows,
        now,
        // The framework's own pending fact: `connecting` with nothing yet is a
        // catalog that has not arrived, which is a different thing from a
        // catalog with no runs in it.
        loading: () => opts.readout().status === "connecting" && rows().length === 0,
        onOpen: (id) => go({ at: "run", runId: id, log: null }),
        onCreate: () => go({ at: "new" }),
      }),
    }),
    el(Show, {
      when: () => route().at === "new",
      children: create({
        state: creating,
        onStart: start,
        onOpen: (id) => go({ at: "run", runId: id, log: null }),
        onBack: () => go({ at: "board" }),
      }),
    }),
    el(Show, {
      when: () => route().at === "run",
      children: detail({
        run: selectedRun,
        frame,
        pending: () => nodesSub.pending(),
        error: () => nodesSub.error(),
        selected,
        onSelect: (node) => {
          const id = runId();
          if (id === null) return;
          go({
            at: "run",
            runId: id,
            log:
              node === null
                ? null
                : formatLogKey({ runId: id, node: node.id, attempt: node.attempt }),
          });
        },
        tail,
        tailPending,
        tailError,
        page,
        onFullPage: readFullLog,
        control,
        controls,
        onBack: () => go({ at: "board" }),
      }),
    }),
  );
}
