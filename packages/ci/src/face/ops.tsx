/**
 * THE RUNS' OPERATIONS — what `odu ci hosts | lease | release`, `odu ci
 * history import | prune` and `odu ci protect` do, without a terminal.
 *
 * Two pages, because they answer two questions:
 *
 *   - **Machines** (`#/machines`) — where would a run go, and who holds it?
 *     The configured fleet as a table, read off the `venues` cell. The service
 *     has no verb that lists machines WITHOUT dialling them, so the page asks
 *     for one probe when it opens on an empty cell and otherwise draws the
 *     reading the service already kept; **Probe machines** refreshes it
 *     (narrowable to platforms). Then
 *     `venue.hold` / `venue.release` for a checkout, the hold the CLI calls a
 *     lease. It is a ROW of the shell's rail now rather than a page behind the
 *     board, which is why it draws no way back: the rail is the way back.
 *   - **Maintenance** (`#/maintain`) — the catalog and the forge: bring a
 *     checkout's legacy records in, expire finished runs, and require exactly
 *     the checks odu posts on a branch. Reached from the board's toolbar,
 *     because these are the runs' own administrative verbs rather than a row
 *     of the application.
 *
 * **Every write here starts as a DRY RUN** where the verb has one (import,
 * prune, protect): the box is ticked by default, the answer says what WOULD
 * happen, and the person unticks it to mean it — the rule the skill teaches an
 * agent, kept for a person too.
 *
 * Drawn by role, refused by the row: the shell hands `canRun` (the runs'
 * `member` floor) and `canAdminister` (`protect.apply`'s `admin` floor), and the
 * service refuses on its own whatever this page draws.
 *
 * ONE GRAMMAR FOR EVERY OPERATION, which is what makes a page of six of them
 * readable: a panel, a small heading, its fields, one button, and the answer
 * under it. That is `.admin-section`, and nothing here is an exception to it.
 */

import { createControl, type Control } from "@odu/face/control";
import { ago } from "@odu/cordis/format";
import {
  BackLink,
  Button,
  Disclosure,
  Facts,
  Field,
  Fields,
  PageHead,
  Panel,
  Pill,
  Receipt,
  Table,
  type TableColumn,
  TextInput,
  Toggle,
} from "@odu/face/ui";
import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js";
import type { Effect } from "effect";
import { requestId } from "./format";
import type { VenueReading, VenueRow } from "./types";
import type { CiClient } from "./ci";

type Call = <A>(effect: Effect.Effect<A, unknown>) => Promise<A>;

function tokens(raw: string): string[] {
  return raw.split(/\s+/).filter((token) => token !== "");
}

/** A control's answer, as this face draws every receipt: `Receipt`, whose
 *  refused tone interrupts and whose answer waits its turn. */
function ControlAnswer(props: { control: Control }): JSX.Element {
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

// ── machines ────────────────────────────────────────────────────────────────

/** WHO HOLDS THIS MACHINE, in the width of a column. A machine nobody holds
 *  says so with a dash rather than a sentence, because this column is read
 *  down rather than across. */
function venueHolder(row: VenueRow, now: number): string {
  if (row.state === "local") return "local — no remote lock";
  const held = row.heldBy;
  if (held === null) return "—";
  const minutes = Math.max(0, Math.round((now - held.sinceMs) / 60_000));
  return `${held.holder}${held.run === null ? "" : ` · ${held.run}`} · ${minutes}m`;
}

/** WHAT A MACHINE'S STATE IS WORTH IN COLOUR. The four venue states are the
 *  same kind of fact a run's status is — can work land here or not — so they
 *  wear the same five hues and nothing else on this page is coloured at all.
 *  A total `Record`, so a fifth venue state is a type error rather than an
 *  uncoloured cell. */
const VENUE_HUE: Record<VenueRow["state"], "green" | "amber" | "grey" | "red"> = {
  free: "green",
  local: "green",
  busy: "amber",
  down: "red",
};

/**
 * WHY A MACHINE IS NOT ANSWERING — the ssh sentence, as the row's second line.
 *
 * Every configured host is a row whether or not it answered: `probeHost`
 * returns an `unreachable` result carrying ssh's own words rather than
 * dropping the machine. This is the half of that row no column can hold — a
 * sentence as long as ssh wants it — so it is a note UNDER the row, clipped to
 * one line with the whole of it in the cell's `title`.
 *
 * The age is NOT here: it is a column now, which is where a fact every row
 * has belongs. `null` for a machine that answered — a note under every row
 * would bury the ones that matter.
 */
export function venueNote(row: VenueRow): string | null {
  if (row.state !== "down") return null;
  return row.error ?? "did not answer, and the probe gave no reason";
}

/**
 * THE HOSTS FILE, IN THE WIDTH OF A TOOLBAR.
 *
 * The path that won is a fact worth having and a `/nix/store/…-hosts.json` is
 * 60 characters of hash nobody reads — printed in full it was the longest
 * string on the page and the reason the toolbar wrapped. The last segment is
 * what distinguishes one from another; the whole path rides `title`, so
 * nothing is lost and the line stays one line.
 */
export function venueSource(source: string | null): { label: string; title: string } {
  if (source === null) return { label: "local lanes only", title: "no hosts file was found" };
  const last = source.split("/").filter((part) => part !== "").at(-1) ?? source;
  return { label: last, title: source };
}

/**
 * HOW MUCH OF THE FLEET IS UP — and, when the reading is a SLICE, that it is
 * one (PLAN 4.4).
 *
 * A machine that is `down` is the only one work cannot land on, so that is
 * what the count is drawn at; busy is a machine doing exactly what it is for.
 *
 * The slice clause is the correction. A probe narrowed by the Platforms field
 * REPLACES the kept reading, so after one narrowed probe this page drew two
 * rows and said "2 of 2 up" — a sentence about the whole inventory, made out
 * of a question about a tenth of it, with the machines it did not probe
 * nowhere on the screen. Naming the platforms is what makes the number true.
 *
 * `undefined` for either ABSENCE — the cell has not answered (`undefined`),
 * or it answered that nothing has probed since this service started (`null`).
 * Both of them here rather than one here and one at the caller: "when is there
 * no line" is one rule, and neither "not asked yet" nor "asked and empty" is a
 * count, so a confident `0 of 0 up` is worse than no line either way.
 *
 * NO AGE. It was here and in the toolbar and in a third `Probed …` facts
 * line, three readings of one clock stacked above a five-row table. The age
 * belongs beside the control that refreshes it, and on each row.
 */
export function fleetLine(reading: VenueReading | undefined): string | undefined {
  if (reading === undefined || reading === null) return undefined;
  const up = reading.rows.filter((row) => row.state !== "down").length;
  const slice =
    reading.platforms.length === 0
      ? ""
      : ` · ${reading.platforms.join(" ")} only, not the whole inventory`;
  return `${up} of ${reading.rows.length} up${slice}`;
}

/**
 * THE FLEET, ONE ROW PER VENUE — which machine, which platform, how it last
 * read, how old that reading is, and who has it.
 *
 * FIVE FIXED COLUMNS, SIZED TO WHAT THEY HOLD, and only `Holder` gives. The
 * previous shape left `Machine` with no width, so the one column holding a
 * twelve-character host name absorbed every pixel a wider window added — 911
 * of 1631 at 1920 — and squeezed the four facts a person actually scans into
 * the right edge. A column's width is a property of its CONTENT, not of the
 * window: an ssh address is `ci@pureintent`, a platform is a Nix tuple, a
 * state is one word, an age is `12m`. Holder is the one unbounded string
 * (login · run · age), so it takes the slack and clips.
 *
 * SLOT is gone as a column and rides `Machine`, shown only for a pool with
 * more than one: `1/1` down a whole table is a column of no information, and
 * this page is read down its columns.
 *
 * The clock arrives as a thunk because the age and holder columns tick
 * between probes while the rows themselves do not move.
 */
function venueColumns(now: () => number, probedAt: () => number): ReadonlyArray<TableColumn<VenueRow>> {
  return [
    {
      key: "host",
      label: "Machine",
      width: "15rem",
      cell: (row) => (
        <span class="venue-host" title={row.host}>
          {row.host}
          <Show when={row.slots > 1}>
            <span class="venue-slot">{` ${row.slot + 1}/${row.slots}`}</span>
          </Show>
        </span>
      ),
    },
    { key: "platform", label: "Platform", width: "11rem", cell: (row) => <code>{row.platform}</code> },
    {
      key: "state",
      label: "State",
      width: "6rem",
      cell: (row) => <Pill hue={VENUE_HUE[row.state]}>{row.state}</Pill>,
    },
    {
      key: "age",
      label: "Age",
      align: "right",
      width: "5rem",
      // EVERY row's age, because every row is one probe old — the fact a
      // `down` row needs most ("down NOW" and "down when somebody last
      // looked" call for opposite moves) and the one a column states once.
      cell: () => ago(probedAt(), now()),
    },
    { key: "holder", label: "Holder", cell: (row) => venueHolder(row, now()) },
  ];
}

export function Machines(props: {
  client: CiClient;
  call: Call;
  now: number;
  canRun: boolean;
}): JSX.Element {
  const [platforms, setPlatforms] = createSignal("");
  /** THE LAST PROBE, A FACT THE SERVICE KEEPS. A probe dials every machine it
   *  is asked about, so a page that probed per visit would cost a fleet of SSH
   *  connections per glance and wait on the slowest dead box. The cell is what
   *  this page (and every other open one) redraws from when anyone asks for a
   *  fresh reading. */
  const reading = props.client.cells.venues.use();
  const probing = createControl(props.call);
  const probeFor = (names: readonly string[]): void => {
    probing.run(
      props.client.procedures.venue.probe(names.length === 0 ? {} : { platforms: [...names] }),
      (answer) => `Probed ${answer.rows.length} venue${answer.rows.length === 1 ? "" : "s"}.`,
    );
  };
  /** ONE PROBE WHEN THE PAGE OPENS ON AN EMPTY CELL. The service exposes no
   *  verb that lists the configured machines without dialling them —
   *  `venue.probe` reads the hosts file and nothing else does — so a page that
   *  waited for the button showed two forms and no fleet. A kept reading is
   *  drawn as it stands instead, which is what keeps the fan-out at once per
   *  service rather than once per glance. */
  let askedOnOpen = false;
  createEffect(() => {
    // `undefined` is "the cell has not answered yet"; `null` is "it answered,
    // and nothing has probed since this service started".
    const answer = reading.value();
    if (answer === undefined || askedOnOpen) return;
    askedOnOpen = true;
    if (answer === null) probeFor([]);
  });
  /** HOW MANY MACHINES ARE UP, in the page's one line of state — and whether
   *  the reading those machines came from is the whole inventory. The whole
   *  rule is `fleetLine`'s, both absences included. */
  const upLine = createMemo(() => fleetLine(reading.value()));

  const [checkout, setCheckout] = createSignal("");
  /** IS THE HOLD FORM OPEN? The caller's bit, not `<details>`'s — a republish
   *  re-mints this subtree and the platform's own state would die with it. */
  const [holding, setHolding] = createSignal(false);
  const [noWait, setNoWait] = createSignal(false);
  const control = createControl(props.call);
  /** The checkout as typed, empty included — the SERVICE refuses a path that
   *  is not absolute, in its own words. */
  const scope = (): { checkout: string; platforms?: string[] } => {
    const path = checkout().trim();
    const names = tokens(platforms());
    return names.length === 0 ? { checkout: path } : { checkout: path, platforms: names };
  };
  const hold = (): void => {
    const target = scope();
    control.run(
      props.client.procedures.venue.hold({
        ...target,
        ...(noWait() ? { noWait: true } : {}),
        requestId: requestId("hold"),
      }),
      (answer) => {
        return answer.results.map((one) => one.message).join(" ") || "Nothing to hold.";
      },
    );
  };
  const release = (): void => {
    const target = scope();
    control.run(
      props.client.procedures.venue.release({ ...target, requestId: requestId("release") }),
      (answer) => {
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
    <section class="screen ops" aria-label="machines">
      <PageHead title="Machines" sub={upLine()} />
      {/* ONE COMPACT ROW: the slice you want, the control that fetches it, and
          how old what you are looking at is. It was a full-width text input, a
          helper sentence under it, and a separate `Probed … platforms … hosts
          /nix/store/…` line — three bands of chrome above a five-row table,
          and the store path alone was the longest string on the page. The
          placeholder says what the field takes, so the hint is gone; the
          hosts file is its last segment with the whole path on hover. */}
      <div class="venue-bar">
        <Field id="venue-platforms" label="Platforms">
          <TextInput
            id="venue-platforms"
            value={platforms()}
            placeholder="all"
            onValue={setPlatforms}
          />
        </Field>
        <Button disabled={probing.busy()} onClick={() => probeFor(tokens(platforms()))}>
          {probing.busy() ? "Probing…" : "Probe machines"}
        </Button>
        {/* `.venue-age` is the acceptance suite's hook for this phrase, and it
            belongs beside the button that refreshes it. */}
        <Show when={reading.value()}>
          {(answer) => (
            <span class="venue-age">
              {`Probed ${ago(answer().at, props.now)}`}
              <span class="venue-source" title={venueSource(answer().source).title}>
                {venueSource(answer().source).label}
              </span>
            </span>
          )}
        </Show>
      </div>
      <Show when={probing.fault()}>{(message) => <Receipt tone="refused">{message()}</Receipt>}</Show>
      <Show when={reading.value()} fallback={<p class="empty">no probe yet</p>}>
        {(answer) => (
          <>
            <For each={answer().warnings}>{(warning) => <p class="fault">{warning}</p>}</For>
            {/* `.venues` is the acceptance suite's hook for the fleet, and it
                rides the container whichever element draws it. */}
            <Table
              class="venues"
              label="venues"
              columns={venueColumns(() => props.now, () => answer().at)}
              rows={answer().rows}
              // A dead machine's reason is the one fact no column can hold: a
              // sentence from ssh, as long as ssh wants. One line under the
              // row, clipped, with the whole of it on hover.
              note={(row) => {
                const why = venueNote(row);
                return why === null ? null : (
                  <span class="venue-why" title={why}>
                    {why}
                  </span>
                );
              }}
            />
          </>
        )}
      </Show>

      {/* A HOLD IS A STATE CHANGE, so it is the runs' floor: drawn for a
          member, refused by the service below one. BEHIND A DISCLOSURE,
          because it is a form you reach for occasionally under a table you
          read constantly — open, it was half the page's height. */}
      <Show when={props.canRun}>
        <Disclosure
          summary="Hold a machine"
          open={holding()}
          onToggle={() => setHolding((was) => !was)}
        >
          <div class="venue-hold" aria-label="hold">
            <Fields>
              <Field id="hold-checkout" label="Checkout">
                <TextInput id="hold-checkout" value={checkout()} placeholder="/code/app" onValue={setCheckout} />
              </Field>
              <Toggle id="no-wait" checked={noWait()} onChecked={setNoWait}>
                Do not queue behind a holder (--no-wait)
              </Toggle>
            </Fields>
            <div class="control-row">
              <Button disabled={control.busy()} onClick={hold}>
                Hold
              </Button>
              <Button disabled={control.busy()} onClick={release}>
                Release
              </Button>
            </div>
            <ControlAnswer control={control} />
          </div>
        </Disclosure>
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
    <section class="screen ops" aria-label="maintenance">
      {/* "All runs" rather than "Runs": the shell's rail already offers a
          control by that name, and one accessible name on two buttons is
          ambiguous to a person and unaddressable to anything that finds a
          control by what it says. */}
      <BackLink onClick={props.onBack}>All runs</BackLink>
      <PageHead
        title="Maintenance"
        sub="The catalog and the forge. Every write here starts as a dry run — untick it to mean it."
      />
      <Show when={props.canRun} fallback={<p class="empty">Nothing here is yours to change.</p>}>
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
    <Panel
      title="Import a checkout's records"
      note="Brings a checkout's legacy .ci records into the catalog (odu ci history import)."
      label="import"
    >
      <div class="panel-body">
        <div class="admin-section">
          <Field id="import-checkout" label="Checkout to import">
            <TextInput id="import-checkout" value={checkout()} placeholder="/code/app" onValue={setCheckout} />
          </Field>
          <Toggle id="import-dry" checked={dryRun()} onChecked={setDryRun}>
            Dry run — report, change nothing
          </Toggle>
          <Button disabled={control.busy()} onClick={go}>
            Import
          </Button>
          <ControlAnswer control={control} />
        </div>
      </div>
    </Panel>
  );
}

function CatalogPrune(props: { client: CiClient; call: Call }): JSX.Element {
  const [days, setDays] = createSignal("");
  const [dryRun, setDryRun] = createSignal(true);
  const control = createControl(props.call);
  const go = (): void => {
    // Empty is the service's default; anything else is SENT, and the service
    // refuses a retention that is not a positive whole number in its words.
    const raw = days().trim();
    const n = raw === "" ? null : Number(raw);
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
    <Panel
      title="Expire old runs"
      note="Finished runs past the window leave the catalog; a run with a live owner never does."
      label="prune"
    >
      <div class="panel-body">
        <div class="admin-section">
          <Field id="prune-days" label="Retention (days)" hint="Empty means the default, 30.">
            <input
              id="prune-days"
              type="number"
              class="input"
              step="1"
              value={days()}
              placeholder="30"
              onInput={(event) => setDays(event.currentTarget.value)}
            />
          </Field>
          <Toggle id="prune-dry" checked={dryRun()} onChecked={setDryRun}>
            Dry run — report, change nothing
          </Toggle>
          <Button disabled={control.busy()} onClick={go}>
            Prune
          </Button>
          <ControlAnswer control={control} />
        </div>
      </div>
    </Panel>
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
    <Panel
      title="Require odu's checks on a branch"
      note="Sets the branch's required status checks to exactly the contexts odu posts (odu ci protect)."
      label="protect"
    >
      <div class="panel-body">
        <div class="admin-section">
          <Field id="protect-checkout" label="Checkout to protect">
            <TextInput id="protect-checkout" value={checkout()} placeholder="/code/app" onValue={setCheckout} />
          </Field>
          <div class="form-pair">
            <Field id="protect-branch" label="Branch" hint="Empty means the repository's default branch.">
              <TextInput id="protect-branch" value={branch()} placeholder="master" onValue={setBranch} />
            </Field>
            <Field id="protect-platforms" label="Platforms" hint="Empty derives them from the service's hosts file.">
              <TextInput id="protect-platforms" value={platforms()} placeholder="x86_64-linux" onValue={setPlatforms} />
            </Field>
          </div>
          <Toggle id="protect-dry" checked={dryRun()} onChecked={setDryRun}>
            Dry run — show the contexts, write nothing
          </Toggle>
          <Toggle id="protect-create" checked={create()} onChecked={setCreate}>
            Create the ruleset if the branch has none (--create)
          </Toggle>
          <Button disabled={control.busy()} onClick={go}>
            Apply protection
          </Button>
          <ControlAnswer control={control} />
        </div>
      </div>
    </Panel>
  );
}
