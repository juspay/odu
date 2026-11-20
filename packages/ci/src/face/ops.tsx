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

function venueHolder(row: VenueRow, now: number): string {
  if (row.state === "local") return "local — no remote lock";
  const held = row.heldBy;
  if (held === null) return "—";
  const minutes = Math.max(0, Math.round((now - held.sinceMs) / 60_000));
  return `${held.holder}${held.run === null ? "" : ` · ${held.run}`} · ${minutes}m`;
}

const VENUE_HUE: Record<VenueRow["state"], "green" | "amber" | "grey" | "red"> = {
  probing: "grey",
  free: "green",
  local: "green",
  busy: "amber",
  down: "red",
};

export function venueNote(row: VenueRow): string | null {
  if (row.state !== "down") return null;
  return row.error ?? "did not answer, and the probe gave no reason";
}

export function venueSource(source: string | null): { label: string; title: string } {
  if (source === null) return { label: "local lanes only", title: "no hosts file was found" };
  const last = source.split("/").filter((part) => part !== "").at(-1) ?? source;
  return { label: last, title: source };
}

export type FleetReading =
  | { readonly kind: "unasked" }
  | { readonly kind: "never-probed" }
  | { readonly kind: "probed"; readonly reading: NonNullable<VenueReading> };

export const fleetOf = (value: VenueReading | undefined): FleetReading =>
  value === undefined
    ? { kind: "unasked" }
    : value === null
      ? { kind: "never-probed" }
      : { kind: "probed", reading: value };

const probed = (fleet: FleetReading): NonNullable<VenueReading> | undefined =>
  fleet.kind === "probed" ? fleet.reading : undefined;

export function fleetLine(fleet: FleetReading): string | undefined {
  if (fleet.kind !== "probed") return undefined;
  const reading = fleet.reading;
  const slice =
    reading.platforms.length === 0
      ? ""
      : ` · ${reading.platforms.join(" ")} only, not the whole inventory`;
  const waiting = reading.rows.filter((row) => row.state === "probing").length;
  if (waiting > 0) {
    return `probing ${waiting} host${waiting === 1 ? "" : "s"}…${slice}`;
  }
  const up = reading.rows.filter((row) => row.state !== "down").length;
  return `${up} of ${reading.rows.length} up${slice}`;
}

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
      cell: (row) => (row.state === "probing" ? "—" : ago(probedAt(), now())),
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
  const reading = props.client.cells.venues.use();
  const probing = createControl(props.call);
  const probeFor = (names: readonly string[]): void => {
    probing.run(
      props.client.procedures.venue.probe(names.length === 0 ? {} : { platforms: [...names] }),
      (answer) => `Probed ${answer.rows.length} venue${answer.rows.length === 1 ? "" : "s"}.`,
    );
  };
  let askedOnOpen = false;
  const fleet = createMemo(() => fleetOf(reading.value()));
  createEffect(() => {
    const current = fleet();
    if (current.kind === "unasked" || askedOnOpen) return;
    askedOnOpen = true;
    if (current.kind === "never-probed") probeFor([]);
  });
  const upLine = createMemo(() => fleetLine(fleet()));

  const [checkout, setCheckout] = createSignal("");
  const [holding, setHolding] = createSignal(false);
  const [noWait, setNoWait] = createSignal(false);
  const control = createControl(props.call);
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
        <Show when={probed(fleet())}>
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
            <Table
              class="venues"
              label="venues"
              columns={venueColumns(() => props.now, () => answer().at)}
              rows={answer().rows}
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

export function Maintain(props: {
  client: CiClient;
  call: Call;
  canRun: boolean;
  canAdminister: boolean;
  onBack: () => void;
}): JSX.Element {
  return (
    <section class="screen ops" aria-label="maintenance">
      <BackLink onClick={props.onBack}>All runs</BackLink>
      <PageHead
        title="Maintenance"
        sub="The catalog and the forge. Every write here starts as a dry run — untick it to mean it."
      />
      <Show when={props.canRun} fallback={<p class="empty">Nothing here is yours to change.</p>}>
        <CatalogImport client={props.client} call={props.call} />
        <CatalogPrune client={props.client} call={props.call} />
      </Show>
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
