import { createEffect, createSignal, For, onCleanup, Show, type JSX } from "solid-js";

export type StatusHue = "grey" | "amber" | "green" | "red" | "violet";

type ButtonAction =
  | { type?: "button"; onClick: () => void }
  | { type: "submit"; onClick?: never };

export type ButtonProps = {
  children: JSX.Element;
  title?: string;
  disabled?: boolean;
  /** Extra classes BESIDE `btn`, which this component always writes. */
  class?: string;
  /** What this button's `<form method="dialog">` closes with, read back as the
   *  dialog's `returnValue`. */
  value?: string;
  pressed?: boolean;
} & ButtonAction;

export function Button(props: ButtonProps): JSX.Element {
  return (
    <button
      type={props.type ?? "button"}
      class={props.class === undefined ? "btn" : `btn ${props.class}`}
      disabled={props.disabled}
      title={props.title}
      value={props.value}
      // `undefined` REMOVES the attribute and `false` writes `"false"`.
      aria-pressed={props.pressed}
      onClick={props.onClick}
    >
      {props.children}
      <Hint text={props.title} />
    </button>
  );
}

export function Hint(props: { text: string | undefined }): JSX.Element {
  return (
    <Show when={props.text !== undefined}>
      <span class="tip" aria-hidden="true" data-hint={props.text} />
    </Show>
  );
}

export function Field(props: {
  id: string;
  label: string;
  hint?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div class="field">
      <label for={props.id}>{props.label}</label>
      {props.children}
      <Show when={props.hint !== undefined}>
        <p class="hint">{props.hint}</p>
      </Show>
    </div>
  );
}

export function TextInput(props: {
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

export function SearchInput(props: {
  label: string;
  value: string;
  placeholder: string;
  onValue: (value: string) => void;
  class?: string;
}): JSX.Element {
  return (
    <label class={props.class === undefined ? "search" : `search ${props.class}`}>
      <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
        <circle cx="7" cy="7" r="4.5" />
        <path d="M10.5 10.5 14 14" />
      </svg>
      <input
        type="search"
        aria-label={props.label}
        value={props.value}
        placeholder={props.placeholder}
        spellcheck={false}
        autocapitalize="off"
        autocorrect="off"
        onInput={(event) => props.onValue(event.currentTarget.value)}
      />
    </label>
  );
}

function CheckInput(props: {
  id: string;
  checked: boolean;
  onChecked: (checked: boolean) => void;
}): JSX.Element {
  return (
    <input
      id={props.id}
      type="checkbox"
      checked={props.checked}
      onChange={(event) => props.onChecked(event.currentTarget.checked)}
    />
  );
}

export function Toggle(props: {
  id: string;
  checked: boolean;
  onChecked: (checked: boolean) => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <label class="toggle" for={props.id}>
      <CheckInput id={props.id} checked={props.checked} onChecked={props.onChecked} />
      {props.children}
    </label>
  );
}

export function Choice(props: {
  name: string;
  value: string;
  checked: boolean;
  label: string;
  note: string;
  onPick: (value: string) => void;
}): JSX.Element {
  return (
    <label class="choice">
      <input
        type="radio"
        name={props.name}
        value={props.value}
        checked={props.checked}
        onChange={() => props.onPick(props.value)}
      />
      <span class="field">
        <span class="choice-name">{props.label}</span>
        <span class="choice-note">{props.note}</span>
      </span>
    </label>
  );
}

export function Pill(props: { hue: StatusHue; children: JSX.Element }): JSX.Element {
  return <span class={`pill hue-${props.hue}`}>{props.children}</span>;
}

export function Tag(props: { hue?: StatusHue; children: JSX.Element }): JSX.Element {
  return (
    <span class={props.hue === undefined ? "tag" : `tag hue-${props.hue}`}>
      {props.children}
    </span>
  );
}

export function Stat(props: { value: JSX.Element; label: string }): JSX.Element {
  return (
    <div class="stat">
      <b>{props.value}</b>
      <span>{props.label}</span>
    </div>
  );
}

export function Panel(props: {
  title?: string;
  note?: string;
  actions?: JSX.Element;
  label?: string;
  class?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <section
      class={props.class === undefined ? "panel" : `panel ${props.class}`}
      aria-label={props.label}
    >
      <Show when={props.title !== undefined}>
        <div class="panel-head">
          <div>
            <h2 class="panel-title">{props.title}</h2>
            <Show when={props.note !== undefined}>
              <p class="panel-note">{props.note}</p>
            </Show>
          </div>
          {props.actions}
        </div>
      </Show>
      {props.children}
    </section>
  );
}

export function KeyValue(props: {
  label: string;
  value: string;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <div class="kv">
      <span class="kv-key">{props.label}</span>
      <span class="kv-value">{props.value}</span>
      {props.children}
    </div>
  );
}

export interface TableColumn<T> {
  /** Also the sort key this header asks for, when `sortable`. */
  readonly key: string;
  readonly label: string;
  readonly align?: "left" | "right";
  /** A fixed width. The column that gives none takes what is left. */
  readonly width?: string;
  readonly sortable?: boolean;
  readonly cell: (row: T) => JSX.Element;
}

export function Table<T>(props: {
  columns: ReadonlyArray<TableColumn<T>>;
  rows: readonly T[];
  class?: string;
  label?: string;
  /** Which column the rows arrived ordered by, and which way. */
  sorted?: { readonly key: string; readonly descending: boolean };
  onSort?: (key: string) => void;
  /** Rows drawn under a row, in the same columns. */
  under?: (row: T) => readonly T[];
  /** One full-width row under those, when there is something to say. */
  note?: (row: T) => JSX.Element | null;
}): JSX.Element {
  const sortOf = (column: TableColumn<T>): "ascending" | "descending" | "none" | undefined => {
    if (props.sorted === undefined || column.sortable !== true) return undefined;
    if (props.sorted.key !== column.key) return "none";
    return props.sorted.descending ? "descending" : "ascending";
  };
  const cells = (row: T): JSX.Element => (
    <For each={props.columns}>
      {(column) => <td class={column.align === "right" ? "right" : undefined}>{column.cell(row)}</td>}
    </For>
  );
  return (
    <table class={props.class === undefined ? "table" : `table ${props.class}`} aria-label={props.label}>
      <thead>
        <tr>
          <For each={props.columns}>
            {(column) => (
              <th
                scope="col"
                class={column.align === "right" ? "right" : undefined}
                style={column.width === undefined ? undefined : { width: column.width }}
                aria-sort={sortOf(column)}
              >
                <Show when={column.sortable === true} fallback={column.label}>
                  <button type="button" class="sort" onClick={() => props.onSort?.(column.key)}>
                    {column.label}
                    <span class="arrow" aria-hidden="true">
                      {sortOf(column) === "ascending"
                        ? "↑"
                        : sortOf(column) === "descending"
                          ? "↓"
                          : ""}
                    </span>
                  </button>
                </Show>
              </th>
            )}
          </For>
        </tr>
      </thead>
      <tbody>
        <For each={props.rows}>
          {(row) => (
            <>
              <tr class="table-row">{cells(row)}</tr>
              <For each={props.under?.(row) ?? []}>
                {(under) => <tr class="table-sub-row">{cells(under)}</tr>}
              </For>
              <Show when={props.note?.(row)}>
                {(note) => (
                  <tr class="table-note">
                    <td colSpan={props.columns.length}>{note()}</td>
                  </tr>
                )}
              </Show>
            </>
          )}
        </For>
      </tbody>
    </table>
  );
}

export interface Fact {
  readonly label?: string;
  readonly value: JSX.Element;
  readonly muted?: boolean;
}

export function Facts(props: { items: readonly Fact[] }): JSX.Element {
  return (
    <span class="facts-line">
      <For each={props.items}>
        {(fact) => (
          <span class={fact.muted === true ? "fact muted" : "fact"}>
            <Show when={fact.label}>{(label) => <span class="fact-label">{label()}</span>}</Show>
            {fact.value}
          </span>
        )}
      </For>
    </span>
  );
}

export function Disclosure(props: {
  summary: JSX.Element;
  open: boolean;
  onToggle: () => void;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div class="disclosure">
      <button
        type="button"
        class="disclosure-summary"
        aria-expanded={props.open}
        onClick={() => props.onToggle()}
      >
        <span class="disclosure-caret" aria-hidden="true">{props.open ? "▾" : "▸"}</span>
        {props.summary}
      </button>
      <Show when={props.open}>{props.children}</Show>
    </div>
  );
}

export function Fields(props: { children: JSX.Element }): JSX.Element {
  return <div class="fields">{props.children}</div>;
}

export type Copied = "copied" | "refused" | "no clipboard";

export async function copyText(text: string): Promise<Copied> {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard === undefined) return "no clipboard";
  try {
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "refused";
  }
}

export function CopyButton(props: { text: string; label?: string }): JSX.Element {
  const [said, setSaid] = createSignal<string | null>(null);
  let reset: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(reset));
  const press = (): void => {
    clearTimeout(reset);
    void copyText(props.text).then((answer) => {
      setSaid(answer);
      reset = setTimeout(() => setSaid(null), 1400);
    });
  };
  return (
    <button type="button" class="btn copy" data-copy onClick={press}>
      {said() ?? props.label ?? "Copy"}
    </button>
  );
}

export interface LaneCell {
  /** What this cell is, in words: `fmt@x86_64-linux, passed`. */
  readonly label: string;
  /** The status hue, or `null` for a node nothing has happened to yet. */
  readonly hue: StatusHue | null;
  readonly skipped?: boolean;
}

export function LaneStrip(props: {
  /** The platform, shortened — `linux`, `darwin`. Empty for a single-lane run. */
  label?: string;
  cells: ReadonlyArray<LaneCell>;
}): JSX.Element {
  return (
    <span class="lane-strip">
      <Show when={props.label !== undefined}>
        <span class="lane-strip-label">{props.label}</span>
      </Show>
      <span class="lane-cells">
        <For each={props.cells}>
          {(cell) => (
            <span
              role="img"
              aria-label={cell.label}
              title={cell.label}
              class={[
                "cell",
                cell.hue === null ? "hue-grey" : `hue-${cell.hue}`,
                cell.skipped === true ? "cell-skipped" : "",
              ]
                .filter((one) => one !== "")
                .join(" ")}
            />
          )}
        </For>
      </span>
    </span>
  );
}

export function BackLink(props: { children: JSX.Element; onClick: () => void }): JSX.Element {
  return (
    <button type="button" class="back" onClick={props.onClick}>
      <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M10 3 5 8l5 5" />
      </svg>
      {props.children}
    </button>
  );
}

export function PageHead(props: {
  title: JSX.Element;
  mono?: boolean;
  sub?: JSX.Element;
  actions?: JSX.Element;
  /** Extra classes BESIDE `page-head`. */
  class?: string;
}): JSX.Element {
  return (
    <header class={props.class === undefined ? "page-head" : `page-head ${props.class}`}>
      <div>
        <h1 class={props.mono === true ? "mono" : undefined}>{props.title}</h1>
        <Show when={props.sub !== undefined}>
          <p class="page-sub">{props.sub}</p>
        </Show>
      </div>
      {props.actions}
    </header>
  );
}

export function Confirm(props: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}): JSX.Element {
  let dialog: HTMLDialogElement | undefined;
  createEffect(() => {
    const el = dialog;
    if (el === undefined) return;
    // Guarded both ways: `showModal()` on an already-open dialog throws, and
    // `close()` on a shut one fires a second `close` event.
    if (props.open && !el.open) {
      el.returnValue = "";
      el.showModal();
    }
    if (!props.open && el.open) el.close();
  });
  return (
    <dialog
      class="confirm"
      ref={dialog}
      onClose={() => {
        if (dialog?.returnValue === "confirm") props.onConfirm();
        props.onClose();
      }}
    >
      <h2>{props.title}</h2>
      <p>{props.body}</p>
      <form method="dialog" class="confirm-actions">
        <Button type="submit" value="cancel">
          {props.cancelLabel}
        </Button>
        <Button
          type="submit"
          value="confirm"
          class={props.danger === true ? "btn-danger" : undefined}
        >
          {props.confirmLabel}
        </Button>
      </form>
    </dialog>
  );
}

export function Receipt(props: {
  tone: "ok" | "refused";
  children: JSX.Element;
  onDismiss?: () => void;
}): JSX.Element {
  return (
    <p
      class="receipt"
      classList={{ "receipt-bad": props.tone === "refused" }}
      role={props.tone === "refused" ? "alert" : "status"}
    >
      <span class="receipt-text">{props.children}</span>
      <Show when={props.onDismiss !== undefined}>
        <Button
          class="receipt-dismiss btn-quiet"
          title="clear this receipt"
          onClick={() => props.onDismiss?.()}
        >
          Dismiss
        </Button>
      </Show>
    </p>
  );
}
