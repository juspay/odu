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

export type CiClient = SurfaceClient<ServiceSpec>;

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
  call: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;
  onRoute: (next: CiRoute) => void;
  bucketHref: (bucket: string) => string;
  ambient: CiAmbient;
  connecting: boolean;
  canRun: boolean;
  canAdminister: boolean;
}

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

function streamArg(stream: LogStream): { stream?: "push" } {
  return stream === "push" ? { stream } : {};
}

function logWasRewritten(page: LogPage, cursor: number | undefined): boolean {
  return cursor !== undefined && cursor > 0 && page.offset < cursor;
}

const FOLLOW_RETRY_MS = 1_500;
const FOLLOW_RETRY_LIMIT = 20;

const START_DEADLINE_MS = 20_000;

export interface CiAmbient {
  readonly rows: Accessor<RunRow[]>;
  readonly checkouts: Accessor<CheckoutFrame[]>;
  readonly unreadable: Accessor<{ repoRoot: string; message: string }[]>;
  readonly tally: Accessor<{ failing: number; active: number }>;
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
    return newestFirst(out);
  });

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
      if (frame !== undefined) out.push(frame);
    }
    return out;
  });
  const unreadable = createMemo<{ repoRoot: string; message: string }[]>(() => {
    const out: { repoRoot: string; message: string }[] = [];
    for (const { repoRoot, sub } of checkoutSubs()) {
      const failure = sub.error();
      if (failure !== undefined) out.push({ repoRoot, message: String(failure) });
    }
    return out;
  });
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

  const { rows, checkouts, unreadable } = props.ambient;

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
  const address = createMemo(() => {
    const key = logKey();
    return key === null ? null : parseLogKey(key);
  });
  const selected = createMemo<RunNode | null>(() => {
    const at = address();
    if (at === null) return null;
    return frame()?.nodes.find((node) => node.id === at.node) ?? null;
  });
  const selectedAttempt = createMemo<number | null>(
    () => address()?.attempt ?? null,
  );
  const [streamChoice, setStreamChoice] = createSignal<LogStream>("recipe");
  const stream = createMemo<LogStream>(() =>
    streamChoice() === "push" && selected()?.push !== undefined
      ? "push"
      : "recipe",
  );
  createEffect(
    on(
      () => address()?.node ?? null,
      () => setStreamChoice("recipe"),
    ),
  );
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

  const [page, setPage] = createSignal<LogPage | null>(null);

  const [control, setControl] = createSignal<ControlState>({ kind: "idle" });
  const [creating, setCreating] = createSignal<CreateState>({ kind: "idle" });
  const [preview, setPreview] = createSignal<PreviewState>({ kind: "idle" });

  const call = <A,>(
    effect: Effect.Effect<A, unknown>,
    onOk: (value: A) => void,
    onRefused: (message: string) => void,
  ): void => {
    void props.call(effect).then(onOk, (err: unknown) => onRefused(refusalText(err)));
  };

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
          ...(current.repo === null ? { noPost: true } : {}),
        }),
        (receipt) =>
          receipt.accepted
            ? `Started ${receipt.runId}.`
            : `That checkout already has a live run: ${receipt.runId}.`,
      );
    },
    dismiss: (): void => {
      setControl({ kind: "idle" });
    },
  };

  const FOLLOW_WAIT_MS = 30_000;
  const [followed, setFollowed] = createSignal<string | null>(null);
  const [followedPage, setFollowedPage] = createSignal<FollowedPage | null>(
    null,
  );
  const [logFault, setLogFault] = createSignal<string | null>(null);
  createEffect(() => {
    const key = logKey();
    const reading = stream();
    setFollowed(null);
    setFollowedPage(null);
    setLogFault(null);
    if (key === null) return;
    let live = true;
    onCleanup(() => {
      live = false;
    });
    void (async () => {
      let cursor: number | undefined;
      let text = "";
      let refusals = 0;
      while (live) {
        let page: LogPage;
        try {
          page = await props.call(
            props.client.procedures.log.read({
              key,
              ...(cursor === undefined ? { offset: -LOG_TAIL_BYTES } : { offset: cursor }),
              limit: LOG_PAGE_BYTES,
              waitMs: FOLLOW_WAIT_MS,
              ...streamArg(reading),
            }),
          );
        } catch (err) {
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
        setFollowedPage({ size: page.size, complete: page.complete });
        if (logWasRewritten(page, cursor)) {
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
        if (!logHasMore(page)) return;
      }
    })();
  });

  const readLogPage = (offset: number): void => {
    const key = logKey();
    if (key === null) return;
    const reading = stream();
    const mine = (): boolean => logKey() === key && stream() === reading;
    call(
      props.client.procedures.log.read({
        key,
        offset,
        limit: LOG_PAGE_BYTES,
        ...streamArg(reading),
      }),
      (answer) => {
        if (!mine()) return;
        setPage(answer);
      },
      (message) => {
        if (!mine()) return;
        setLogFault(message);
      },
    );
  };

  let startToken = 0;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
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

  const previewPipeline = (checkout: string, root: string): void => {
    setPreview({ kind: "reading" });
    call(
      props.client.procedures.pipeline.read({ checkout, ...(root === "" ? {} : { root }) }),
      (pipeline) => setPreview({ kind: "read", pipeline }),
      (message) => setPreview({ kind: "refused", message }),
    );
  };

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
