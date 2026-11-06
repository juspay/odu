/**
 * THE RUNS' FACE — the board, the create form, one run, and the runs'
 * operations (machines, maintenance), as one component.
 *
 * This is `ci`'s half of the page, in the package that owns the runs: the board
 * row, the DAG, the console, the controls. `@odu/web-ui` holds the SHELL — the
 * address bar's router, the wire indicator, the Runs / Cache switch, the tab —
 * and hands each face its client and the route. That split is what the fence
 * asks for: a view that renders a row's contract lives in that row's package,
 * and the shell names rows only from the one file that is allowed to.
 *
 * It holds the runs' client and no other. The cache's client is the shell's to
 * hand to `@odu/cache/face`, and a view here that could reach a bucket would be
 * a view doing another row's job.
 */

import type { SurfaceClient } from "@kolu/surface/solid";
import type { SurfaceReadout } from "@kolu/surface/solid";
import { refusalText } from "@odu/face/refusal";
import { formatLogKey, parseLogKey } from "@odu/service-client/logKey";
import { logHasMore, LOG_TAIL_BYTES } from "@odu/service-client/surface";
import { type oduServiceSurface } from "@odu/service-client/surface";
import { boardTally, checkoutRoots, newestFirst } from "@odu/service-client/board";
import type { Effect } from "effect";
import {
  createEffect,
  createMemo,
  createSignal,
  mapArray,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
  type Accessor,
  type JSX,
} from "solid-js";
import { Board } from "./board";
import { type FollowedPage, requestId } from "./format";
// The primitives this face draws with live in `@odu/face/ui` — the package of
// no row — so the shell and every row's face get one answer to what a control
// IS. This module used to re-export `Button` for the shell, which made the
// runs' package the home of a control the cache and the account card also
// press; the shell imports it from the design system now, and a face that
// re-exported furniture was a door the fence would eventually have to close.
import { Create, type CreateState, type PreviewState, type StartForm } from "./create";
import { Machines, Maintain } from "./ops";
import {
  type ControlState,
  Detail,
  LOG_PAGE_BYTES,
  LogPanel,
  openingNode,
} from "./detail";
import type {
  CheckoutFrame,
  LogPage,
  LogStream,
  LogTail,
  NodesFrame,
  RunNode,
  RunRow,
} from "./types";

type ServiceSpec = (typeof oduServiceSurface)["spec"];

/** The runs' client, as a view holds it. */
export type CiClient = SurfaceClient<ServiceSpec>;

/** WHERE THE RUNS' FACES ARE ADDRESSED — the subset of the page's routes this
 *  face answers. The shell's own type adds the cache's. */
export type CiRoute =
  | { at: "board" }
  | { at: "new" }
  | { at: "machines" }
  | { at: "maintain" }
  | { at: "run"; runId: string; log: string | null };

export interface CiFaceProps {
  client: CiClient;
  route: CiRoute;
  now: number;
  /** The shell's one UI edge; see `call` below. */
  call: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  /** Move the address. The shell owns the router, so the face asks. */
  onRoute: (next: CiRoute) => void;
  /** WHERE A BUCKET'S PAGE IS. The shell owns every cross-row address, the
   *  way it owns the router: a run's page links the bucket it pushes to
   *  (PLAN 4.1) and does not get to spell `#/cache/<name>` itself. */
  bucketHref: (bucket: string) => string;
  /** The board's facts, built once by the shell so the tab keeps counting while
   *  another row is on screen. */
  ambient: CiAmbient;
  /** The wire has not answered yet — the board's empty state is "arriving",
   *  not "nothing ran". */
  connecting: boolean;
  /** MAY THIS PERSON CHANGE A RUN? The runs' floor is `member`, and the gate
   *  has already refused everyone below it — the shell passes the floor anyway,
   *  because the rule is the ROW's and this is where it would narrow. */
  canRun: boolean;
  /** MAY THIS PERSON ADMINISTER? `protect.apply` writes the forge with the
   *  daemon's credential, so its floor is `admin`; the service refuses below
   *  it whatever this face draws. */
  canAdminister: boolean;
}


/**
 * A read that is TERMINAL when refused: the key names nothing, or the service
 * says this build may not read it. The follow stops rather than retrying a
 * refusal it will keep refusing.
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

/** HOW LONG A START MAY GO UNANSWERED before the form takes its button back.
 *
 *  A number the FACE owns, because it is about a control rather than about
 *  the wire: `run.start` has its own timeouts and its own retries, and this is
 *  the point past which a person staring at `Starting…` has learnt nothing
 *  more by waiting. Twenty seconds is comfortably longer than a cold
 *  coordinator's own admission path — a start that is merely slow still lands
 *  normally and the receipt replaces this one — and short enough that a tab
 *  whose websocket died while it slept does not look broken for a minute.
 *
 *  See {@link CiFace}'s `start` for why the call is not cancelled with it. */
const START_DEADLINE_MS = 20_000;

/** WHAT THE PAGE KNOWS ABOUT THE RUNS WHETHER OR NOT IT IS DRAWING THEM.
 *
 * The board's rows are a collection plus one stream per checkout, and the tab's
 * counts are folded from them. All of that has to outlive the face: a person
 * reading buckets still has a title bar, and a run that fails while they are
 * there is exactly the fact that bar exists to carry. So the facts are built
 * HERE, once, by whoever owns the page — the shell — and handed to the face it
 * draws. A face that built them itself would unmount them with itself, which is
 * the bug this shape removes.
 */
export interface CiAmbient {
  /** The board's rows, newest first. */
  readonly rows: Accessor<RunRow[]>;
  /** One frame per checkout, in the order the roots arrived. */
  readonly checkouts: Accessor<CheckoutFrame[]>;
  /** The checkouts the service could not be read for. */
  readonly unreadable: Accessor<{ repoRoot: string; message: string }[]>;
  /** How many runs are failing and how many are going — the tab's two numbers. */
  readonly tally: Accessor<{ failing: number; active: number }>;
  /** One run by id, or nothing while it is not in the collection. */
  readonly rowOf: (runId: string) => RunRow | undefined;
}

export function ciAmbient(client: CiClient): CiAmbient {
  const runs = client.collections.runs.use();
  const rows = createMemo<RunRow[]>(() => {
    const out: RunRow[] = [];
    for (const key of runs.keys()) {
      const row = runs.byKey(key)?.();
      if (row !== undefined) out.push(row);
    }
    // Newest first. Sorted HERE rather than trusted from the wire: under batched
    // delivery `keys()` is arrival order, which the framework's own contract
    // says to treat as a set rather than a list. The order itself is
    // `@odu/service-client/board`'s, so every reader of a board sorts alike.
    return newestFirst(out);
  });

  // ── one subscription per checkout ──
  //
  // The board's rows are checkouts, and what a checkout IS — the run it stands
  // for, that run's work, how many ran before — is `streams.checkout`'s answer,
  // folded by the service on the catalog's own clock. This app addresses them
  // and paints the answers; it does not re-derive any of it from `rows`.
  //
  // `mapArray` keys the subscriptions by checkout path, so a new checkout opens
  // ONE stream and the others are left alone — an `Index`-shaped re-subscribe
  // on every catalog tick would reopen every one of them four times a second.
  const checkoutSubs = createMemo(
    mapArray(
      () => checkoutRoots(rows()),
      (repoRoot) => ({
        repoRoot,
        sub: client.streams.checkout.use(() => ({ repoRoot })),
      }),
    ),
  );
  const checkouts = createMemo<CheckoutFrame[]>(() => {
    const out: CheckoutFrame[] = [];
    for (const { sub } of checkoutSubs()) {
      const frame = sub();
      // A checkout whose first frame has not landed yet is not an empty
      // checkout, so it is absent from the list rather than an empty row.
      if (frame !== undefined) out.push(frame);
    }
    return out;
  });
  /**
   * The checkouts the service could not be read for.
   *
   * A failed subscription is NOT an absent one. Dropped, a checkout whose
   * stream died simply leaves the board while its runs are still listed under
   * History — so the board answers "what is my CI doing here" with silence
   * about the one checkout it could not answer for. The frame carries no
   * `repoRoot`, which is why the path is held beside the subscription rather
   * than recovered from the reading that did not arrive.
   */
  const unreadable = createMemo<{ repoRoot: string; message: string }[]>(() => {
    const out: { repoRoot: string; message: string }[] = [];
    for (const { repoRoot, sub } of checkoutSubs()) {
      const failure = sub.error();
      if (failure !== undefined) out.push({ repoRoot, message: String(failure) });
    }
    return out;
  });
  /** The run each checkout STANDS FOR — what the board shows, and so what the
   *  tab counts. */
  const standingFor = createMemo<RunRow[]>(() => {
    const out: RunRow[] = [];
    for (const checkout of checkouts()) {
      if (checkout.latest !== null) out.push(checkout.latest.run);
    }
    return out;
  });

  return {
    rows,
    checkouts,
    unreadable,
    tally: createMemo(() => boardTally(standingFor())),
    rowOf: (runId) => runs.byKey(runId)?.(),
  };
}

export function CiFace(props: CiFaceProps): JSX.Element {
  const route = (): CiRoute => props.route;
  const now = (): number => props.now;
  const go = (next: CiRoute): void => props.onRoute(next);

  // ── the board ──
  //
  // BUILT ELSEWHERE, because the page needs these facts whether or not it is
  // drawing them: the tab counts runs while a person reads buckets. See
  // `ciAmbient` above.
  const { rows, checkouts, unreadable } = props.ambient;

  // ── the selected run ──
  const runId = createMemo(() => {
    const at = route();
    return at.at === "run" ? at.runId : null;
  });
  const selectedRun = createMemo<RunRow | undefined>(() => {
    const id = runId();
    return id === null ? undefined : props.ambient.rowOf(id);
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
  //
  // AND A RUN THAT NAMES NO NODE OPENS ON ONE. `#/run/<id>` — what the board,
  // the create form and a pasted link all produce — used to land on a blank
  // console beside a list with the failure already drawn red in it. The
  // fallback is `openingNode`'s choice, turned into a key here because this is
  // where the run's nodes are; it is not written INTO the address, so the
  // address a person copied is still the address they get back and Back still
  // walks out of the run rather than out of a node it never chose.
  //
  // It is a DERIVATION and not a one-shot choice: while the address names no
  // node the pane follows the evidence, so a failure that lands in a live run
  // somebody is watching brings its own log with it. One click pins it — that
  // is what writing the address does, and from then on nothing moves the pane
  // but the reader.
  const logKey = createMemo<string | null>(() => {
    const at = route();
    if (at.at !== "run") return null;
    if (at.log !== null) return at.log;
    const opening = openingNode(frame()?.nodes ?? []);
    return opening === null
      ? null
      : formatLogKey({
          runId: at.runId,
          node: opening.id,
          attempt: opening.attempt,
        });
  });
  /** THE ADDRESS, taken apart ONCE. The node and the attempt are two halves of
   *  one key, and they used to be two memos each parsing the same string and
   *  keeping half the answer. */
  const address = createMemo(() => {
    const key = logKey();
    return key === null ? null : parseLogKey(key);
  });
  const selected = createMemo<RunNode | null>(() => {
    const at = address();
    if (at === null) return null;
    // Matched on the node ID ALONE, and the attempt is carried beside it below.
    // `RunNode.attempt` is the HIGHEST attempt the run recorded, while the
    // address may name an older one — which is the whole point of the attempt
    // picker, and is also what a link pasted before a retry becomes. Matching on
    // both fields resolved every one of those to `null`, so the panel closed on
    // exactly the person who had asked to read an earlier failure.
    return frame()?.nodes.find((node) => node.id === at.node) ?? null;
  });
  /** WHICH attempt the address names — read off the key rather than off the
   *  node, for the reason above: they differ, and the difference is the thing
   *  the picker exists to express. */
  const selectedAttempt = createMemo<number | null>(
    () => address()?.attempt ?? null,
  );
  /**
   * WHICH OF THE NODE'S TWO LOGS IS BEING READ.
   *
   * A SIGNAL and not the address, unlike the node and the attempt. Those two
   * are the SUBJECT — what a pasted link is about, what Back walks out of —
   * and a stream is a lens on one subject, the way the wrap toggle and the
   * scroll position are. Writing it into `#/run/<id>/<key>` would have widened
   * the one string this system hands out in failures, in `odu ci logs` and in
   * the MCP face for a choice that costs one click to make again.
   *
   * The CHOICE is held raw; {@link stream} below is what anything reads.
   */
  const [streamChoice, setStreamChoice] = createSignal<LogStream>("recipe");
  /** WHICH STREAM IS ACTUALLY ASKED FOR — the choice, narrowed by what the
   *  selected node HAS. A node with no push step has no push log, and asking
   *  for one would be a read nobody can answer, drawn under tabs that are not
   *  on screen. A derivation rather than a correction in an effect, because an
   *  effect runs AFTER the render that would have asked. */
  const stream = createMemo<LogStream>(() =>
    streamChoice() === "push" && selected()?.push !== undefined
      ? "push"
      : "recipe",
  );
  /** A DIFFERENT NODE OPENS ON ITS RECIPE. The stream is a lens on one
   *  subject, so a new subject gets the default lens: somebody who read one
   *  node's push log and then clicked the failure below it is asking about
   *  that node's work, not about its upload. Keyed on the node alone —
   *  switching ATTEMPT stays on the stream you were reading, which is the
   *  whole point of comparing two attempts' push logs. */
  createEffect(
    on(
      () => address()?.node ?? null,
      () => setStreamChoice("recipe"),
    ),
  );
  // The whole-log page is cleared whenever the address moves OR the stream
  // does: a panel left showing the previous node's output under a new heading
  // is the worst kind of stale, and a page of the recipe's log left standing
  // under the Push tab is the same staleness wearing a different label. The
  // dependencies are SAID rather than left to bare `logKey();` statements that
  // read as dead code to everything but Solid.
  createEffect(on([logKey, stream], () => setPage(null)));
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
  const [preview, setPreview] = createSignal<PreviewState>({ kind: "idle" });

  /**
   * THE UI EDGE: the one place a description becomes execution, and the one
   * place a thrown refusal becomes a sentence.
   *
   * Every caller below says only what it does with the two answers. There used
   * to be four `Effect.runPromise` call sites under a header claiming one, and
   * three of them re-spelled the refusal branch by hand.
   */
  const call = <A,>(
    effect: Effect.Effect<A, unknown>,
    onOk: (value: A) => void,
    onRefused: (message: string) => void,
  ): void => {
    // THE EDGE IS THE SHELL'S (`props.call`), not this view's: one
    // `Effect.runPromise` per page is what keeps "a control's whole story"
    // checkable in one place, and the cache's face takes the same one.
    void props.call(effect).then(onOk, (err: unknown) => onRefused(refusalText(err)));
  };

  /** A CONTROL's whole story, through that edge: pending, then a receipt or a
   *  refusal, in the one state the run view draws. */
  const run = <A,>(
    what: string,
    effect: Effect.Effect<A, unknown>,
    onOk: (value: A) => string,
  ): void => {
    setControl({ kind: "pending", what });
    call(
      effect,
      (value) => setControl({ kind: "ok", message: onOk(value) }),
      (message) => setControl({ kind: "refused", message }),
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
          // dropping the reporting. That refusal is right for `odu ci run`,
          // where a person may simply not have configured a remote yet. It is
          // wrong HERE: this button repeats a run that already ran in this
          // checkout, which means it ran with posting off — so asking for it
          // with posting on is not repeating it, it is asking for something odu
          // will decline for a reason nobody can act on from this page. `repo`
          // is the row's own word for "this checkout has a GitHub origin", so
          // the browser says what it is already holding rather than finding out.
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
   * THE LIVE LOG, FOLLOWED BYTE-EXACTLY — parity with `odu ci attach`.
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
   * `odu ci logs -f` and the attach TUI run, holding `nextOffset` and appending.
   * One mechanism, three faces, and no face that quietly sees less.
   *
   * `logTails` stays for the header's `totalBytes` / `complete`, which are
   * facts about the whole file rather than about what has been read — and
   * facts about the RECIPE's file only, which is why the push stream is
   * followed through this loop and drawn without a tail behind it.
   */
  /** One followed read's deadline. `run_wait`'s, deliberately — a longer one
   *  holds a request open past what a proxy between a tab and the service will
   *  tolerate, and the loop re-issues anyway. */
  const FOLLOW_WAIT_MS = 30_000;
  const [followed, setFollowed] = createSignal<string | null>(null);
  /**
   * WHAT THE FOLLOW LEARNED BESIDES THE TEXT — the last page's size and
   * whether the file is whole.
   *
   * Every page carries these two facts about the WHOLE file, and this loop
   * used to keep `text` and drop them on the floor. For the recipe that cost
   * nothing — `logTails` carries the same facts for that file — but the push
   * stream has no tail behind it, so the Push tab could state a size only
   * after somebody pressed a paging button, and the rest of the time the
   * pane's byte count was the recipe's. Keeping the page's own facts makes
   * the push stream's size a thing the pane knows for free, live, from the
   * one reader it already has.
   *
   * Null until a page lands, and null again on every new subject, because
   * "how big is this file" has no answer before the first read of it.
   */
  const [followedPage, setFollowedPage] = createSignal<FollowedPage | null>(
    null,
  );
  /** Why this log could not be READ — a refused page, or a follow that gave up.
   *  ONE destination for one event class: the two read paths used to report the
   *  same refusal in two widgets, the follow's beside the pane it is about and
   *  a button's as a receipt at the top of the run view, chosen by nothing but
   *  which function happened to make the call. Shown rather than swallowed,
   *  because a pane that has quietly stopped updating looks exactly like a log
   *  that has quietly stopped growing. */
  const [logFault, setLogFault] = createSignal<string | null>(null);
  // BOTH HALVES of what is being read are tracked here. The key names the
  // attempt; the stream names which of its two logs — and an effect that read
  // only the key went on appending the recipe's bytes into a pane that had
  // switched to the push, which is the silent-loss failure this whole loop
  // exists to remove, wearing the other log's label.
  //
  // Both are read ONCE, at the top, and the loop below closes over the
  // VALUES: nothing inside the async body reads a signal, so this effect's
  // dependencies are exactly these two and a re-run is always a new subject.
  createEffect(() => {
    const key = logKey();
    const reading = stream();
    setFollowed(null);
    setFollowedPage(null);
    setLogFault(null);
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
          // NOT through `call`: this one crossing needs the `try`/`continue`
          // below, because a dropped read here is resumed from the cursor
          // rather than reported and abandoned. It is the one exception the
          // module header names — and it still uses the SHELL's edge
          // (`props.call`), so the page runs exactly one `Effect.runPromise`.
          page = await props.call(
            props.client.procedures.log.read({
              key,
              ...(cursor === undefined ? { offset: -LOG_TAIL_BYTES } : { offset: cursor }),
              limit: LOG_PAGE_BYTES,
              waitMs: FOLLOW_WAIT_MS,
              // ABSENT for the recipe, which is what the verb's own default
              // means — so a 2.6 browser against a 2.5 daemon asks for
              // exactly what it always asked for, and only the push tab (a
              // tab that daemon's runs never grow, because they report no
              // node push) names a field it would not know.
              ...(reading === "recipe" ? {} : { stream: reading }),
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
            setLogFault(refusalText(err));
            return;
          }
          refusals += 1;
          if (refusals > FOLLOW_RETRY_LIMIT) {
            setLogFault(
              "odu: lost contact with the service while following this log",
            );
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, FOLLOW_RETRY_MS));
          continue;
        }
        if (!live) return;
        refusals = 0;
        setLogFault(null);
        // THE PAGE'S OWN FACTS, kept rather than discarded — see
        // {@link followedPage}. Recorded here, above the rewind branch, so
        // every answered read updates them: a log that was rewritten under
        // the cursor is a SMALLER file, and a size left standing from before
        // the rewrite is exactly the stale number this pane must never show.
        setFollowedPage({ size: page.size, complete: page.complete });
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

  /**
   * A WINDOW OF THIS LOG, and of no other.
   *
   * A read is fire-and-forget — `call` hands the promise to two callbacks and
   * returns — so its answer lands whenever the service gets to it, which may
   * be after the reader has moved on. The SUBJECT is the key and the stream
   * together, and this call site used to write whatever came back into the
   * one `page` signal with no check that either was still the one that asked.
   *
   * That is defect A, and it was not theoretical: a recipe page in flight
   * when the reader pressed Push landed AFTER the effect that clears the
   * signal, and the Push tab then drew the recipe's text, the recipe's
   * offsets and the recipe's size — a page's worth of the wrong file,
   * labelled with the right one. A pane that shows nothing is a pane a
   * reader retries; a pane that shows the wrong log is one they believe.
   *
   * So the read carries what it asked about and the answer is dropped unless
   * both halves still match — the same rule the start path's token guard
   * states, for the same reason: a late answer is still an answer, but only
   * to the question that is still being asked. The REFUSAL is guarded too; a
   * recipe read's refusal printed beside the push pane accuses the wrong
   * file.
   */
  const readLogPage = (offset: number): void => {
    const key = logKey();
    if (key === null) return;
    const reading = stream();
    const mine = (): boolean => logKey() === key && stream() === reading;
    call(
      // ALWAYS bounded. The verb will happily return a whole log, and this used
      // to ask for one — a request whose cost is set by whatever the recipe
      // printed, which is not a thing a browser may bet a tab on.
      //
      // SAME STREAM the follow is reading — the two call sites answer one
      // question between them ("what is in this log") and a page that silently
      // came from the recipe while the pane said Push would be the worst kind
      // of wrong answer: a plausible one.
      props.client.procedures.log.read({
        key,
        offset,
        limit: LOG_PAGE_BYTES,
        ...(reading === "recipe" ? {} : { stream: reading }),
      }),
      (answer) => {
        if (!mine()) return;
        setPage(answer);
      },
      // Beside the pane, not in the receipt channel over the node list: this is
      // the same fact the follow reports, and a refusal that landed in one of
      // two widgets depending on which read asked for it was one event class
      // with two homes.
      (message) => {
        if (!mine()) return;
        setLogFault(message);
      },
    );
  };

  /**
   * A START, BOUNDED — the form's button always comes back.
   *
   * `run.start` used to leave `starting` only from inside its own callbacks,
   * which is a bet that every call settles. It does not: a websocket that
   * went stale while the tab was asleep — the ordinary outcome of restarting
   * the daemon under an open page — leaves the request with nowhere to land,
   * and the form sat on a disabled `Starting…` with no way out but a reload.
   * A control a person cannot press and cannot clear is worse than a refusal,
   * because a refusal at least says what happened.
   *
   * So the deadline is the FORM's, not the wire's: after
   * {@link START_DEADLINE_MS} the button comes back and a sentence beside it
   * says what odu does and does not know. The sentence is careful on purpose —
   * an unanswered start may well have started a run, and telling somebody it
   * failed would invite a second one.
   *
   * A LATE ANSWER IS STILL AN ANSWER. The timer takes the button back; it does
   * not cancel the call, and if the receipt arrives afterwards it lands
   * normally — opening the run that did start is exactly what the person asked
   * for. What it must never do is land on a DIFFERENT attempt, so each start
   * carries a token and a stale one is dropped on the floor.
   */
  let startToken = 0;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  // The view can be torn down between a press and its answer — a route change,
  // a sign-out — and a timer that outlived it would write into a signal nobody
  // is drawing. Registered once, at setup, where there IS an owner to register
  // it on; `start` itself runs from an event handler, outside any.
  onCleanup(() => clearTimeout(startTimer));
  const start = (form: StartForm): void => {
    setCreating({ kind: "starting" });
    startToken += 1;
    const token = startToken;
    clearTimeout(startTimer);
    startTimer = setTimeout(() => {
      if (token !== startToken) return;
      setCreating({
        kind: "refused",
        message:
          "odu: the service did not answer this start within " +
          `${Math.round(START_DEADLINE_MS / 1_000)}s. The connection may have dropped — ` +
          "check All runs for the run before starting another.",
      });
    }, START_DEADLINE_MS);
    call(
      props.client.procedures.run.start({
        checkout: form.checkout,
        expectedSha: form.expectedSha,
        requestId: requestId("start"),
        // ABSENT rather than empty: the wire's optional keys mean "not said",
        // and an empty array is a caller asserting a choice they did not make.
        ...(form.selectors.length === 0 ? {} : { selectors: form.selectors }),
        ...(form.platforms.length === 0 ? {} : { platforms: form.platforms }),
        ...(form.hostPins.length === 0 ? {} : { hostPins: form.hostPins }),
        ...(form.root === "" ? {} : { root: form.root }),
        ...(form.hostsFile === "" ? {} : { hostsFile: form.hostsFile }),
        ...(form.noDeps ? { noDeps: true } : {}),
        ...(form.noStrict ? { noStrict: true, noSnapshot: true } : {}),
        ...(form.noPost ? { noPost: true } : {}),
        ...(form.supersede ? { supersede: true } : {}),
        ...(form.linger ? { linger: true } : {}),
      }),
      (receipt) => {
        if (token !== startToken) return;
        clearTimeout(startTimer);
        if (receipt.accepted) {
          setCreating({ kind: "started", runId: receipt.runId });
          props.onRoute({ at: "run", runId: receipt.runId, log: null });
          return;
        }
        setCreating({
          kind: "existing",
          runId: receipt.runId,
          sha: receipt.existing?.sha ?? receipt.sha,
        });
      },
      (message) => {
        if (token !== startToken) return;
        clearTimeout(startTimer);
        setCreating({ kind: "refused", message });
      },
    );
  };

  /** A FRESH FORM every time the route enters `new`. The face outlives the
   *  screen — `Create` is re-minted by the `<Match>`, its fields with it, but
   *  the start's own state lives up here — so without this a person who
   *  started a run, landed on it and pressed New run again met the previous
   *  answer: a `started` receipt about a run they were no longer looking at,
   *  or a refusal they had already read. The preview goes with it for the same
   *  reason: it is an answer about a checkout this visit has not named yet.
   *
   *  The token moves too, so a start still in flight from the previous visit
   *  cannot land on this form. */
  createEffect(
    on(
      () => props.route.at === "new",
      (entering) => {
        if (!entering) return;
        startToken += 1;
        clearTimeout(startTimer);
        setCreating({ kind: "idle" });
        setPreview({ kind: "idle" });
      },
    ),
  );

  /** `pipeline.read` — what the create form's checkout would run. The
   *  checkout is sent as typed, empty included: the SERVICE refuses a path that
   *  is not absolute, and its sentence is what the person reads. */
  const previewPipeline = (checkout: string, root: string): void => {
    setPreview({ kind: "reading" });
    call(
      props.client.procedures.pipeline.read({ checkout, ...(root === "" ? {} : { root }) }),
      (pipeline) => setPreview({ kind: "read", pipeline }),
      (message) => setPreview({ kind: "refused", message }),
    );
  };

  /** MOVE THE ADDRESS, never a signal beside it — the rule the node selection
   *  and the attempt picker both keep, so an earlier attempt is a link like any
   *  other view here, Back walks out of it, and the tail subscription follows
   *  because it is keyed by the log key. One mint, because the two callers
   *  differed only in where the node and the attempt came from. */
  const goToLog = (node: string | null, attempt: number): void => {
    const id = runId();
    if (id === null) return;
    props.onRoute({
      at: "run",
      runId: id,
      log: node === null ? null : formatLogKey({ runId: id, node, attempt }),
    });
  };

  return (
    <Switch>
        <Match when={route().at === "board"}>
          <Board
            checkouts={checkouts()}
            unreadable={unreadable()}
            rows={rows()}
            now={now()}
            // The framework's own pending fact: `connecting` with nothing yet is
            // a catalog that has not arrived, which is a different thing from a
            // catalog with no runs in it.
            loading={props.connecting && rows().length === 0}
            onOpen={(id) => props.onRoute({ at: "run", runId: id, log: null })}
            onCreate={() => props.onRoute({ at: "new" })}
            onMaintain={() => props.onRoute({ at: "maintain" })}
          />
        </Match>
        <Match when={route().at === "machines"}>
          <Machines
            client={props.client}
            call={props.call}
            now={now()}
            canRun={props.canRun}
            // NO `onBack`: Machines is a ROW of the shell's rail now, and the
            // rail is how a person leaves it. A second way out, drawn inside
            // the page, would be the one control here that duplicates the
            // frame around it.
          />
        </Match>
        <Match when={route().at === "maintain"}>
          <Maintain
            client={props.client}
            call={props.call}
            canRun={props.canRun}
            canAdminister={props.canAdminister}
            onBack={() => props.onRoute({ at: "board" })}
          />
        </Match>
        <Match when={route().at === "new"}>
          <Create
            state={creating()}
            canRun={props.canRun}
            onStart={start}
            preview={preview()}
            onPreview={previewPipeline}
            onOpen={(id) => props.onRoute({ at: "run", runId: id, log: null })}
            onBack={() => props.onRoute({ at: "board" })}
          />
        </Match>
        <Match when={route().at === "run"}>
          <Detail
            run={selectedRun()}
            canRun={props.canRun}
            frame={frame()}
            bucketHref={props.bucketHref}
            now={now()}
            pending={nodesSub.pending()}
            error={nodesSub.error()}
            selected={selected()}
            onSelect={(node) => goToLog(node?.id ?? null, node?.attempt ?? 0)}
            // THE LOG PANE, built here where the wire already is rather than
            // threaded through `Detail` as nine props it never reads.
            log={
              <LogPanel
                node={selected()}
                attempt={selectedAttempt()}
                onAttempt={(attempt) =>
                  goToLog(selected()?.id ?? null, attempt)
                }
                stream={stream()}
                onStream={setStreamChoice}
                tail={tail()}
                followed={followed()}
                followedPage={followedPage()}
                logFault={logFault()}
                tailPending={tailPending()}
                tailError={tailError()}
                page={page()}
                onPage={readLogPage}
              />
            }
            control={control()}
            controls={controls}
            onBack={() => props.onRoute({ at: "board" })}
          />
        </Match>
    </Switch>
  );
}
