/**
 * THE RUNS' OPERATIONS — what `odu hosts | lease | release`, `odu history
 * import | prune` and `odu protect` do, without a terminal.
 *
 * Two pages, because they answer two questions:
 *
 *   - **Machines** (`#/machines`) — where would a run go, and who holds it?
 *     `venue.probe` on open (it SSH-dials, so it can be narrowed to platforms),
 *     and `venue.hold` / `venue.release` for a checkout, the hold the CLI calls
 *     a lease.
 *   - **Maintenance** (`#/maintain`) — the catalog and the forge: bring a
 *     checkout's legacy records in, expire finished runs, and require exactly
 *     the checks odu posts on a branch.
 *
 * **Every write here starts as a DRY RUN** where the verb has one (import,
 * prune, protect): the box is ticked by default, the answer says what WOULD
 * happen, and the person unticks it to mean it — the rule the skill teaches an
 * agent, kept for a person too.
 *
 * Drawn by role, refused by the row: the shell hands `canRun` (the runs'
 * `member` floor) and `canAdminister` (`protect.apply`'s `admin` floor), and the
 * service refuses on its own whatever this page draws.
 */

import { createResource, createSignal, For, onCleanup, Show, type JSX } from "solid-js";
import type { Effect } from "effect";
import { Button, Field, Receipt } from "./dom";
import type { VenueRow } from "./types";
import type { CiClient } from "./ci";

type Call = <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;

/** A request id a repeat of this page's own click cannot duplicate — see
 *  `./ci`'s twin for why the service demands one. */
function requestId(what: string): string {
  return `web-${what}-${crypto.randomUUID()}`;
}

function refusalText(err: unknown): string {
  const value = err as { message?: unknown; suggestion?: unknown };
  const message = typeof value?.message === "string" ? value.message : String(err);
  const suggestion = Array.isArray(value?.suggestion)
    ? ` Try: ${(value.suggestion as unknown[]).map(String).join(" ")}`
    : "";
  return `${message}${suggestion}`;
}

function tokens(raw: string): string[] {
  return raw.split(/\s+/).filter((token) => token !== "");
}

/** ONE CONTROL'S STORY — pending, then a receipt or a refusal — owned by the
 *  component that made it, so an answer after the page closed writes nowhere. */
function createControl(call: Call): {
  readonly state: () => { kind: "idle" } | { kind: "busy" } | { kind: "ok" | "refused"; message: string };
  readonly refuse: (message: string) => void;
  readonly run: <A>(effect: Effect.Effect<A, unknown>, ok: (value: A) => string) => void;
} {
  type State = { kind: "idle" } | { kind: "busy" } | { kind: "ok" | "refused"; message: string };
  const [state, setState] = createSignal<State>({ kind: "idle" });
  let live = true;
  onCleanup(() => {
    live = false;
  });
  return {
    state,
    refuse: (message) => setState({ kind: "refused", message }),
    run: (effect, ok) => {
      setState({ kind: "busy" });
      void call(effect).then(
        (value) => {
          if (live) setState({ kind: "ok", message: ok(value) });
        },
        (err: unknown) => {
          if (live) setState({ kind: "refused", message: refusalText(err) });
        },
      );
    },
  };
}

function ControlAnswer(props: { control: ReturnType<typeof createControl> }): JSX.Element {
  return (
    <Show
      when={(() => {
        const state = props.control.state();
        return state.kind === "ok" || state.kind === "refused" ? state : null;
      })()}
    >
      {(answer) => <Receipt tone={answer().kind === "ok" ? "ok" : "refused"}>{answer().message}</Receipt>}
    </Show>
  );
}

const busy = (control: ReturnType<typeof createControl>): boolean =>
  control.state().kind === "busy";

function TextInput(props: {
  id: string;
  value: string;
  placeholder: string;
  onValue: (value: string) => void;
}): JSX.Element {
  return (
    <input
      id={props.id}
      type="text"
      class="input"
      value={props.value}
      placeholder={props.placeholder}
      spellcheck={false}
      autocapitalize="off"
      autocorrect="off"
      onInput={(event) => props.onValue(event.currentTarget.value)}
    />
  );
}

function Check(props: {
  id: string;
  checked: boolean;
  onChecked: (checked: boolean) => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <label class="toggle" for={props.id}>
      <input
        id={props.id}
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChecked(event.currentTarget.checked)}
      />
      {props.children}
    </label>
  );
}

// ── machines ────────────────────────────────────────────────────────────────

/** How one venue reads, in a phrase. */
function venueState(row: VenueRow, now: number): string {
  switch (row.state) {
    case "free":
      return "free";
    case "local":
      return "local — no remote lock";
    case "down":
      return `down — ${row.error ?? "unreachable"}`;
    case "busy": {
      const held = row.heldBy;
      if (held === null) return "busy";
      const minutes = Math.max(0, Math.round((now - held.sinceMs) / 60_000));
      return `held by ${held.holder}${held.run === null ? " (a hold)" : ` for ${held.run}`} · ${minutes}m`;
    }
  }
}

export function Machines(props: {
  client: CiClient;
  call: Call;
  now: number;
  canRun: boolean;
  onBack: () => void;
}): JSX.Element {
  const [platforms, setPlatforms] = createSignal("");
  /** The platforms the PROBE was last asked about — the resource's key, so
   *  typing in the box dials nothing until the person asks. A fresh object per
   *  ask, so asking the same thing twice probes twice. Every platform on open. */
  const [asked, setAsked] = createSignal<{ readonly names: readonly string[] }>({ names: [] });
  type Probe =
    | { ok: true; rows: readonly VenueRow[]; source: string | null; warnings: readonly string[] }
    | { ok: false; message: string };
  const [probe, { refetch }] = createResource(asked, async ({ names }): Promise<Probe> => {
    try {
      const answer = await props.call(
        props.client.procedures.venue.probe(names.length === 0 ? {} : { platforms: [...names] }),
      );
      return { ok: true, rows: answer.rows, source: answer.source, warnings: answer.warnings };
    } catch (err) {
      return { ok: false, message: refusalText(err) };
    }
  });

  const [checkout, setCheckout] = createSignal("");
  const [noWait, setNoWait] = createSignal(false);
  const control = createControl(props.call);
  const scope = (): { checkout: string; platforms?: string[] } | null => {
    const path = checkout().trim();
    if (path === "") {
      control.refuse("odu: a hold is recorded against a checkout — type its absolute path");
      return null;
    }
    const names = tokens(platforms());
    return names.length === 0 ? { checkout: path } : { checkout: path, platforms: names };
  };
  const hold = (): void => {
    const target = scope();
    if (target === null) return;
    control.run(
      props.client.procedures.venue.hold({
        ...target,
        ...(noWait() ? { noWait: true } : {}),
        requestId: requestId("hold"),
      }),
      (answer) => {
        void refetch();
        return answer.results.map((one) => one.message).join(" ") || "Nothing to hold.";
      },
    );
  };
  const release = (): void => {
    const target = scope();
    if (target === null) return;
    control.run(
      props.client.procedures.venue.release({ ...target, requestId: requestId("release") }),
      (answer) => {
        void refetch();
        return (
          answer.released
            .map((one) =>
              one.effective === "released"
                ? `Released ${one.platform}${one.host === null ? "" : ` on ${one.host}`}.`
                : `Nothing held for ${one.platform}${one.detail === null ? "" : ` — ${one.detail}`}.`,
            )
            .join(" ") || "Nothing was held."
        );
      },
    );
  };

  return (
    <section class="create ops" aria-label="machines">
      <header class="detail-head">
        <Button onClick={props.onBack}>← Runs</Button>
        <h1>Machines</h1>
      </header>
      <div class="create-form">
        <Field
          id="venue-platforms"
          label="Platforms"
          hint="Space-separated. Empty means every configured platform — a probe dials each machine, so naming one skips the rest."
        >
          <TextInput
            id="venue-platforms"
            value={platforms()}
            placeholder="x86_64-linux aarch64-darwin"
            onValue={setPlatforms}
          />
        </Field>
        <Button onClick={() => setAsked({ names: tokens(platforms()) })}>
          {probe.loading ? "Probing…" : "Probe machines"}
        </Button>
      </div>
      <Show when={(() => { const value = probe(); return value !== undefined && !value.ok ? value.message : null; })()}>
        {(message) => <Receipt tone="refused">{message()}</Receipt>}
      </Show>
      <Show when={(() => { const value = probe(); return value !== undefined && value.ok ? value : null; })()}>
        {(answer) => (
          <>
            <p class="hint">
              {answer().source === null ? "No hosts file — local lanes only." : `From ${answer().source}.`}
            </p>
            <For each={answer().warnings}>{(warning) => <p class="fault">{warning}</p>}</For>
            <ul class="tokens venues">
              <For each={answer().rows}>
                {(row) => (
                  <li>
                    <span>
                      <code>{row.platform}</code> <strong>{row.host}</strong>
                      <span class="hint">{` slot ${row.slot + 1}/${row.slots}`}</span>
                    </span>
                    <span class="hint">{venueState(row, props.now)}</span>
                  </li>
                )}
              </For>
            </ul>
          </>
        )}
      </Show>

      {/* A HOLD IS A STATE CHANGE, so it is the runs' floor: drawn for a
          member, refused by the service below one. */}
      <Show when={props.canRun}>
        <section class="admin-section" aria-label="hold">
          <h3>Hold or release</h3>
          <p class="hint">
            A hold is recorded against a checkout and outlives this page — release it when done.
            The platforms above narrow it; empty means every one.
          </p>
          <Field id="hold-checkout" label="Checkout" hint="The absolute path the hold is for.">
            <TextInput id="hold-checkout" value={checkout()} placeholder="/code/app" onValue={setCheckout} />
          </Field>
          <Check id="no-wait" checked={noWait()} onChecked={setNoWait}>
            Do not queue behind a holder (--no-wait)
          </Check>
          <div class="control-row">
            <Button disabled={busy(control)} onClick={hold}>
              Hold
            </Button>
            <Button disabled={busy(control)} onClick={release}>
              Release
            </Button>
          </div>
          <ControlAnswer control={control} />
        </section>
      </Show>
    </section>
  );
}

// ── maintenance ─────────────────────────────────────────────────────────────

export function Maintain(props: {
  client: CiClient;
  call: Call;
  canRun: boolean;
  canAdminister: boolean;
  onBack: () => void;
}): JSX.Element {
  return (
    <section class="create ops" aria-label="maintenance">
      <header class="detail-head">
        <Button onClick={props.onBack}>← Runs</Button>
        <h1>Maintenance</h1>
      </header>
      <Show when={props.canRun} fallback={<p class="hint">Nothing here is yours to change.</p>}>
        <CatalogImport client={props.client} call={props.call} />
        <CatalogPrune client={props.client} call={props.call} />
      </Show>
      {/* `protect.apply` writes the forge with the daemon's credential — an
          admin's act, so drawn for the admin floor and refused below it. */}
      <Show when={props.canAdminister}>
        <Protect client={props.client} call={props.call} />
      </Show>
    </section>
  );
}

function CatalogImport(props: { client: CiClient; call: Call }): JSX.Element {
  const [checkout, setCheckout] = createSignal("");
  const [dryRun, setDryRun] = createSignal(true);
  const control = createControl(props.call);
  const go = (): void => {
    const path = checkout().trim();
    if (path === "") return control.refuse("odu: an import reads one checkout — type its absolute path");
    const dry = dryRun();
    control.run(
      props.client.procedures.catalog.import({
        checkout: path,
        ...(dry ? { dryRun: true } : {}),
        requestId: requestId("import"),
      }),
      (report) =>
        `${dry ? "Would import" : "Imported"} ${report.imported.length} run${report.imported.length === 1 ? "" : "s"}` +
        `${report.skipped.length > 0 ? `, skipped ${report.skipped.length}` : ""} into ${report.catalog}.`,
    );
  };
  return (
    <section class="admin-section" aria-label="import">
      <h3>Import a checkout's records</h3>
      <p class="hint">Brings a checkout's legacy .ci records into the catalog (odu history import).</p>
      <Field id="import-checkout" label="Checkout">
        <TextInput id="import-checkout" value={checkout()} placeholder="/code/app" onValue={setCheckout} />
      </Field>
      <Check id="import-dry" checked={dryRun()} onChecked={setDryRun}>
        Dry run — report, change nothing
      </Check>
      <Button disabled={busy(control)} onClick={go}>
        Import
      </Button>
      <ControlAnswer control={control} />
    </section>
  );
}

function CatalogPrune(props: { client: CiClient; call: Call }): JSX.Element {
  const [days, setDays] = createSignal("");
  const [dryRun, setDryRun] = createSignal(true);
  const control = createControl(props.call);
  const go = (): void => {
    const raw = days().trim();
    const n = raw === "" ? null : Number(raw);
    if (n !== null && (!Number.isInteger(n) || n <= 0)) {
      return control.refuse(`odu: retention needs a positive whole number of days (got "${raw}")`);
    }
    const dry = dryRun();
    control.run(
      props.client.procedures.catalog.prune({
        ...(n === null ? {} : { retentionDays: n }),
        ...(dry ? { dryRun: true } : {}),
        requestId: requestId("prune"),
      }),
      (report) =>
        `${dry ? "Would expire" : "Expired"} ${report.expired.length} run${report.expired.length === 1 ? "" : "s"} ` +
        `older than ${report.retentionDays}d` +
        `${report.kept.length > 0 ? `; kept ${report.kept.length} with a live owner` : ""}.`,
    );
  };
  return (
    <section class="admin-section" aria-label="prune">
      <h3>Expire old runs</h3>
      <p class="hint">Finished runs past the window leave the catalog; a run with a live owner never does.</p>
      <Field id="prune-days" label="Retention (days)" hint="Empty means the default, 30.">
        <TextInput id="prune-days" value={days()} placeholder="30" onValue={setDays} />
      </Field>
      <Check id="prune-dry" checked={dryRun()} onChecked={setDryRun}>
        Dry run — report, change nothing
      </Check>
      <Button disabled={busy(control)} onClick={go}>
        Prune
      </Button>
      <ControlAnswer control={control} />
    </section>
  );
}

function Protect(props: { client: CiClient; call: Call }): JSX.Element {
  const [checkout, setCheckout] = createSignal("");
  const [branch, setBranch] = createSignal("");
  const [platforms, setPlatforms] = createSignal("");
  const [dryRun, setDryRun] = createSignal(true);
  const [create, setCreate] = createSignal(false);
  const control = createControl(props.call);
  const go = (): void => {
    const path = checkout().trim();
    if (path === "") return control.refuse("odu: protection is read off a checkout — type its absolute path");
    const names = tokens(platforms());
    control.run(
      props.client.procedures.protect.apply({
        checkout: path,
        ...(branch().trim() === "" ? {} : { branch: branch().trim() }),
        ...(names.length === 0 ? {} : { platforms: names }),
        ...(dryRun() ? { dryRun: true } : {}),
        ...(create() ? { create: true } : {}),
        requestId: requestId("protect"),
      }),
      (answer) =>
        `${answer.dryRun ? "Would require" : answer.applied ? "Now requiring" : "Requires"} ` +
        `${answer.contexts.length} check${answer.contexts.length === 1 ? "" : "s"}` +
        `${answer.branch === null ? "" : ` on ${answer.branch}`}: ${answer.contexts.join(", ")}.` +
        `${answer.derivedFrom === null ? "" : ` Platforms came from ${answer.derivedFrom} — name them to pin this.`}` +
        `${answer.detail === null ? "" : ` ${answer.detail}`}`,
    );
  };
  return (
    <section class="admin-section" aria-label="protect">
      <h3>Require odu's checks on a branch</h3>
      <p class="hint">Sets the branch's required status checks to exactly the contexts odu posts (odu protect).</p>
      <Field id="protect-checkout" label="Checkout">
        <TextInput id="protect-checkout" value={checkout()} placeholder="/code/app" onValue={setCheckout} />
      </Field>
      <Field id="protect-branch" label="Branch" hint="Empty means the repository's default branch.">
        <TextInput id="protect-branch" value={branch()} placeholder="master" onValue={setBranch} />
      </Field>
      <Field id="protect-platforms" label="Platforms" hint="Empty derives them from the service's hosts file.">
        <TextInput id="protect-platforms" value={platforms()} placeholder="x86_64-linux" onValue={setPlatforms} />
      </Field>
      <Check id="protect-dry" checked={dryRun()} onChecked={setDryRun}>
        Dry run — show the contexts, write nothing
      </Check>
      <Check id="protect-create" checked={create()} onChecked={setCreate}>
        Create the ruleset if the branch has none (--create)
      </Check>
      <Button disabled={busy(control)} onClick={go}>
        Apply protection
      </Button>
      <ControlAnswer control={control} />
    </section>
  );
}
