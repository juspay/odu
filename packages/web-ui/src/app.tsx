/**
 * THE SHELL — routing, the connection indicator, and the one place a view meets
 * the wire.
 *
 * Everything reactive is bound here and handed to the views as ordinary props,
 * so a view holds no client and cannot invent a second way to reach the
 * service. That is not tidiness: it is what makes "the browser has no execution
 * or retry logic of its own" a thing you can check by reading one file.
 *
 * **The connection is drawn, not hidden.** The readout is the framework's own
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
import { logHasMore, LOG_TAIL_BYTES } from "@odu/service-client/surface";
import type { oduServiceSurface } from "@odu/service-client/surface";
import { Effect } from "effect";
import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
  type JSX,
} from "solid-js";
import { Board, boardTally } from "./board";
import { Create, type CreateState, type StartForm } from "./create";
import { type ControlState, Detail, LOG_PAGE_BYTES } from "./detail";
import { CONNECTION, faviconSvg } from "./format";
import type { LogPage, LogTail, NodesFrame, RunNode, RunRow } from "./types";

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

/**
 * A read that will never succeed, however many times it is tried.
 *
 * `log.read` REFUSES a key it cannot address — an expired run, an attempt that
 * never ran, a malformed key — and those are answers, not outages. Retrying one
 * is a spinner over a sentence somebody should be reading instead. Everything
 * else (a dropped socket, a service mid-upgrade) is transient by default, which
 * is the safe direction: a follow that resumes too eagerly costs a request, one
 * that gives up too eagerly costs somebody the rest of their log.
 */
const TERMINAL_READ_REFUSALS = new Set([
  "unknown_run",
  "expired",
  "bad_input",
  "checkout_refused",
]);

function isTerminalReadRefusal(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && TERMINAL_READ_REFUSALS.has(code);
}

/** How long to wait before resuming a follow whose read did not answer, and
 *  how many times. Twenty attempts at a second and a half covers a service
 *  restart and an upgrade; past that, saying so beats spinning. */
const FOLLOW_RETRY_MS = 1_500;
const FOLLOW_RETRY_LIMIT = 20;

/** odu's words for the framework's five states. `degraded` is the one that
 *  names what stopped, so the sentence can never come out with a hole in it. */
function wireText(readout: SurfaceReadout): string {
  return readout.status === "degraded"
    ? `${CONNECTION.degraded} — nothing is arriving on ${readout.stopped.join(", ")}`
    : CONNECTION[readout.status];
}

export function App(props: {
  client: Client;
  readout: SurfaceReadout;
  onReload: () => void;
}): JSX.Element {
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
  const runs = props.client.collections.runs.use();
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

  /**
   * THE TAB IS THE AMBIENT MONITOR.
   *
   * The whole point of a browser board is that it can be left open, and a page
   * that is left open is a page nobody is looking at. A tab title and a favicon
   * are the two pixels of this app that stay visible from another window, so
   * they carry the one fact worth interrupting somebody for: is anything broken,
   * and is anything still moving.
   *
   * Counted over the SAME rows AND through the same predicates the board uses —
   * `boardTally`, asked of `./board` rather than re-derived here — because a tab
   * claiming three failures over a board showing one is a tab nobody trusts
   * twice, and sharing only the rows left the predicates free to drift.
   *
   * `document` is guarded because these modules are also loaded outside a
   * browser: `compile.test.ts` runs them through bun to check what the compiler
   * emitted.
   */
  let restingIcon: string | null = null;
  createEffect(() => {
    if (typeof document === "undefined") return;
    const { failing, active } = boardTally(rows());
    // Broken outranks busy: a run still going is worth a glance, a failure is
    // worth coming back for. And it is a WORD as well as a glyph, because a
    // title read aloud is the only version of this some people get.
    document.title =
      failing > 0
        ? `✗ ${failing} failing · odu`
        : active > 0
          ? `● ${active} running · odu`
          : "odu";
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link === null) return;
    // The build hashes the logo's filename, so the resting icon is a URL only
    // the shell knows — remembered on the first pass rather than spelled here,
    // which is also what lets a quiet board go back to the plain mark.
    if (restingIcon === null) restingIcon = link.href;
    link.href =
      failing > 0
        ? faviconSvg("red")
        : active > 0
          ? faviconSvg("amber")
          : restingIcon;
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
  const nodesSub = props.client.streams.nodes.use(() => {
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
    // Matched on the node ID ALONE, and the attempt is carried beside it below.
    // `RunNode.attempt` is the HIGHEST attempt the run recorded, while the
    // address may name an older one — which is the whole point of the attempt
    // picker, and is also what a link pasted before a retry becomes. Matching on
    // both fields resolved every one of those to `null`, so the panel closed on
    // exactly the person who had asked to read an earlier failure.
    return frame()?.nodes.find((node) => node.id === parsed.node) ?? null;
  });
  /** WHICH attempt the address names. Derived from the same key rather than
   *  read off the node, for the reason above: they differ, and the difference
   *  is the thing the picker exists to express. */
  const selectedAttempt = createMemo<number | null>(() => {
    const key = logKey();
    return key === null ? null : (parseLogKey(key)?.attempt ?? null);
  });
  // The whole-log page is cleared whenever the address moves: a panel left
  // showing the previous node's output under a new heading is the worst kind of
  // stale.
  createEffect(() => {
    logKey();
    setPage(null);
  });
  const tails = props.client.collections.logTails.use({
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

  // A WINDOW of the log, on request. Separate from the tail because they answer
  // different questions — see `@odu/service`'s `logs.ts` — and held as the
  // verb's whole answer rather than just its text, because `offset`,
  // `nextOffset`, `size` and `eof` are what let the panel say where the window
  // is and whether there is another one.
  const [page, setPage] = createSignal<LogPage | null>(null);

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
        props.client.procedures.run.retry({
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
        props.client.procedures.run.cancel({
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
        props.client.procedures.run.cancel({
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
        props.client.procedures.run.cancel({
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
        props.client.procedures.run.start({
          checkout: current.repoRoot,
          expectedSha: current.sha,
          requestId: requestId("again"),
          selectors: [...current.scope.selectors],
          platforms: [...current.scope.platforms],
          noDeps: current.scope.noDeps,
          // A checkout with no GitHub origin cannot post commit statuses, and
          // the coordinator REFUSES a posting run there rather than quietly
          // dropping the reporting. That refusal is right for `odu run`, where a
          // person may simply not have configured a remote yet. It is wrong
          // HERE: this button repeats a run that already ran in this checkout,
          // which means it ran with posting off — so asking for it with posting
          // on is not repeating it, it is asking for something odu will decline
          // for a reason nobody can act on from this page. `repo` is the row's
          // own word for "this checkout has a GitHub origin", so the browser
          // says what it is already holding rather than finding out.
          ...(current.repo === null ? { noPost: true } : {}),
        }),
        (receipt) =>
          receipt.accepted
            ? `Started ${receipt.runId}.`
            : `That checkout already has a live run: ${receipt.runId}.`,
      );
    },
    // The receipt has been read. Back to `idle` is the same state every control
    // above starts from, so a dismissal is the one control here that needs no
    // wire at all.
    dismiss: (): void => {
      setControl({ kind: "idle" });
    },
  };

  /**
   * THE LIVE LOG, FOLLOWED BYTE-EXACTLY — parity with `odu attach`.
   *
   * `logTails` streams, and for a long time that was the whole of the browser's
   * live view. But a tail is the last {@link LOG_TAIL_BYTES} re-sent WHOLE on
   * every change, with no cursor: a recipe that outruns the service's 250 ms
   * tick by more than 64 KiB has the excess silently dropped, and the page
   * shows less than happened with nothing to say so. The terminal's log pane
   * does not lose those bytes, and a browser that does is not the same
   * application.
   *
   * So the live pane is a CURSORED follow — the same `log.read` + `waitMs` loop
   * `odu logs -f` and the attach TUI run, holding `nextOffset` and appending.
   * One mechanism, three faces, and no face that quietly sees less.
   *
   * `logTails` stays for the header's `totalBytes` / `complete`, which are
   * facts about the whole file rather than about what has been read.
   */
  /** One followed read's deadline. `run_wait`'s, deliberately — a longer one
   *  holds a request open past what a proxy between a tab and the service will
   *  tolerate, and the loop re-issues anyway. */
  const FOLLOW_WAIT_MS = 30_000;
  const [followed, setFollowed] = createSignal<string | null>(null);
  /** Why the follow stopped, when it did. Shown rather than swallowed: a pane
   *  that has quietly stopped updating looks exactly like a log that has
   *  quietly stopped growing, and they are different things. */
  const [followFault, setFollowFault] = createSignal<string | null>(null);
  createEffect(() => {
    const key = logKey();
    setFollowed(null);
    setFollowFault(null);
    if (key === null) return;
    let live = true;
    // The tab moved on — a new node, a new run, or the view closed. The loop
    // notices at its next answer and stops appending into a pane that is now
    // showing something else.
    onCleanup(() => {
      live = false;
    });
    void (async () => {
      let cursor: number | undefined;
      let text = "";
      // How many reads in a row have failed. A dropped connection is the
      // ordinary case in a browser — a laptop lid, a sleeping tab, a service
      // being upgraded — and it is not a reason to stop watching a log that is
      // still being written. Reset by any answer, so this bounds a service that
      // is GONE rather than one that hiccuped.
      let refusals = 0;
      while (live) {
        let page: LogPage;
        try {
          page = await Effect.runPromise(
            props.client.procedures.log.read({
              key,
              ...(cursor === undefined ? { offset: -LOG_TAIL_BYTES } : { offset: cursor }),
              limit: LOG_PAGE_BYTES,
              waitMs: FOLLOW_WAIT_MS,
            }),
          );
        } catch (err) {
          // RESUMED FROM THE CURSOR, not abandoned. This used to `return`, and
          // the effect is keyed on the log key — so a reader who lost their
          // connection and got it back, without changing node, watched a frozen
          // pane for as long as they cared to look, while the header and the
          // board recovered around it.
          //
          // A REFUSAL is different from a dropped read and says so. `log.read`
          // refuses a key that is not addressable — an expired run, an attempt
          // that never ran — and retrying that forever would be a spinner over
          // an answer nobody is going to change.
          if (!live) return;
          if (isTerminalReadRefusal(err)) {
            setFollowFault(refusalText(err));
            return;
          }
          refusals += 1;
          if (refusals > FOLLOW_RETRY_LIMIT) {
            setFollowFault(
              "odu: lost contact with the service while following this log",
            );
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, FOLLOW_RETRY_MS));
          continue;
        }
        if (!live) return;
        refusals = 0;
        setFollowFault(null);
        // The attempt was re-run underneath us and its log rewritten in place,
        // so the file is shorter than the cursor. Start over rather than show
        // the tail of a different attempt as a continuation of this one.
        if (cursor !== undefined && cursor > 0 && page.offset < cursor) {
          cursor = 0;
          text = "";
          setFollowed("");
          continue;
        }
        cursor = page.nextOffset;
        if (page.text !== "") {
          text += page.text;
          setFollowed(text);
        }
        // `logHasMore`'s rule, shared with the CLI and the TUI. Stopping on
        // `!open` alone dropped whatever the closing page carried — a producer
        // that finishes after appending more than one page leaves an unread
        // remainder behind that flag, and the pane lost the end of the output.
        if (!logHasMore(page)) return;
      }
    })();
  });

  const readLogPage = (offset: number): void => {
    const key = logKey();
    if (key === null) return;
    void Effect.runPromise(
      // ALWAYS bounded. The verb will happily return a whole log, and this used
      // to ask for one — a request whose cost is set by whatever the recipe
      // printed, which is not a thing a browser may bet a tab on.
      props.client.procedures.log.read({ key, offset, limit: LOG_PAGE_BYTES }),
    ).then(
      (answer) => setPage(answer),
      (err: unknown) => setControl({ kind: "refused", message: refusalText(err) }),
    );
  };

  const start = (form: StartForm): void => {
    setCreating({ kind: "starting" });
    void Effect.runPromise(
      props.client.procedures.run.start({
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
  return (
    <div
      class="shell"
      // A RUN is read, so it gets the viewport: `.shell-frame` in `styles.css`
      // turns the page into an app frame whose log pane scrolls inside itself.
      // The board is scanned, so it keeps the page's own scroll.
      classList={{ "shell-frame": route().at === "run" }}
    >
      {/* The masthead, and the wire beside it. The wordmark is `logo.svg`'s own
          idea spelled in text — a slate `$` in front of `odu` in bold mono,
          because odu is a shell prompt you attach to — rather than a second
          drawing of the mark: the logo beside the bundle is content-hashed, so
          a view that named it would be naming a URL only the build knows.

          It is a `<span>` and not a link. There is nowhere for it to go that
          this page is not already, and a decorative control at the top of the
          document is one Tab stop between a person and the first thing they
          came here to press. */}
      <header class="topbar">
        <span class="brand">
          <span class="brand-sigil" aria-hidden="true">$</span>
          <span class="brand-name">odu</span>
        </span>
        <div class={`wire wire-${props.readout.status}`} role="status" aria-live="polite">
          {wireText(props.readout)}
          <Show when={props.readout.needsReload}>
            <button type="button" class="btn" onClick={props.onReload}>
              Reload
            </button>
          </Show>
        </div>
      </header>
      {/* THE ROUTER. `Switch` rather than three independent `Show`s because the
          three are exclusive, and each branch is BUILT ON ENTRY: the compiler
          turns a `Match`'s children into a getter, so leaving a run and coming
          back mints a fresh view rather than re-inserting the one that was
          disposed on the way out — see `./dom`'s header for the failure that
          taught us to care. */}
      <Switch>
        <Match when={route().at === "board"}>
          <Board
            rows={rows()}
            now={now()}
            // The framework's own pending fact: `connecting` with nothing yet is
            // a catalog that has not arrived, which is a different thing from a
            // catalog with no runs in it.
            loading={props.readout.status === "connecting" && rows().length === 0}
            onOpen={(id) => go({ at: "run", runId: id, log: null })}
            onCreate={() => go({ at: "new" })}
          />
        </Match>
        <Match when={route().at === "new"}>
          <Create
            state={creating()}
            onStart={start}
            onOpen={(id) => go({ at: "run", runId: id, log: null })}
            onBack={() => go({ at: "board" })}
          />
        </Match>
        <Match when={route().at === "run"}>
          <Detail
            run={selectedRun()}
            frame={frame()}
            pending={nodesSub.pending()}
            error={nodesSub.error()}
            selected={selected()}
            onSelect={(node) => {
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
            }}
            selectedAttempt={selectedAttempt()}
            // Choosing an attempt moves the ADDRESS, not a signal beside it —
            // the same rule the node selection keeps. So an earlier attempt is a
            // link like any other view here, Back walks out of it, and the tail
            // subscription follows because it is keyed by the log key.
            onAttempt={(attempt) => {
              const id = runId();
              const node = selected();
              if (id === null || node === null) return;
              go({
                at: "run",
                runId: id,
                log: formatLogKey({ runId: id, node: node.id, attempt }),
              });
            }}
            tail={tail()}
            followed={followed()}
            followFault={followFault()}
            tailPending={tailPending()}
            tailError={tailError()}
            page={page()}
            onPage={readLogPage}
            control={control()}
            controls={controls}
            onBack={() => go({ at: "board" })}
          />
        </Match>
      </Switch>
    </div>
  );
}
