/**
 * THE PRIMITIVES EVERY ROW'S FACE DRAWS WITH.
 *
 * They are here, in the package of no row, for the reason `./control` is: two
 * or more rows' faces need them and none of them owns them. They used to live
 * in `@odu/ci/face/dom` — which meant the cache's face, the door's face and
 * the SHELL all reached into the runs' package for a button, and "what a
 * control IS" was a decision one row made for the others.
 *
 * Every component here is MARKUP AND SEMANTICS ONLY. Not one of them names a
 * colour, a size or a layout: that is `./theme.css`, and the agreement between
 * the two is a class name. A row that needs a new look needs a rule there, not
 * a style attribute here.
 *
 * ── THE RULES THE COMPILER CANNOT KEEP FOR YOU ────────────────────────────
 *
 * **Never destructure props.** `props` is an object of getters. `function
 * Row({ run })` reads every one of them once, at call time, and freezes the
 * row. Write `props.run`, always, and pass VALUES rather than accessors — the
 * compiler wraps a dynamic JSX expression in a getter on the way in, so
 * `<Row run={run()} />` stays as fine-grained as handing `Row` the accessor
 * would have been, and reads like markup instead of like plumbing.
 *
 * **`<Show>`'s children are re-created, a value handed in is not.** Solid
 * disposes a branch's computations the first time its condition goes false,
 * and a child built once and handed over as a value is re-inserted DEAD when
 * the condition comes back true. In JSX that hazard is the compiler's problem
 * — `<Show>`'s children compile to a `get children()` accessor — which is why
 * nothing here takes a prebuilt element where a branch is meant.
 *
 * **Solid's JSX is a compile target.** `babel-preset-solid` turns each element
 * into a cloned `<template>` plus one effect per dynamic binding; Bun's own
 * JSX transform would emit `jsx(Component, props)` calls and silently give you
 * a React-shaped render where every component re-runs and every signal inside
 * it is re-created. The loader in `scripts/build-web-ui.ts` claims every
 * `.tsx` in the repo so that cannot happen by accident.
 */

import { createEffect, createSignal, For, onCleanup, Show, type JSX } from "solid-js";

/**
 * THE FIVE SEMANTIC HUES — the vocabulary every coloured thing on this page
 * shares, and the only vocabulary it has.
 *
 * Spelled here rather than imported because this package names no row, and
 * the canonical union is `@odu/run-client`'s. The two are held equal by a
 * type-level assertion in `@odu/ci/face`'s `format` module, which can see
 * both: a hue added on one side and not the other fails to compile there.
 */
export type StatusHue = "grey" | "amber" | "green" | "red" | "violet";

/**
 * WHO ACTS when this button is pressed, and the two answers are exclusive.
 *
 * A plain button carries its own `onClick`. A `submit` button hands the action
 * to its form's `onSubmit` — and must NOT also carry a click handler, because
 * the browser fires both for one mouse press and the form would be submitted
 * twice. For a form that starts a CI run that is two runs, so the mistake is
 * made unspellable here: `onClick` is `never` on the submit branch, and a
 * caller that supplies both fails to compile.
 *
 * `submit` exists at all because it is the only way Enter-in-a-field reaches
 * an `onSubmit` handler. HTML's implicit submission gives up when a form has
 * more than one text field and no submit button, and the create form has five
 * — so while every control in this app was hardcoded `type="button"`, that
 * form's `onSubmit` was unreachable code and the form could not be operated
 * from the keyboard at all.
 */
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
   *  dialog's `returnValue`. Only {@link Confirm} uses it; it is here rather
   *  than hand-spelled there because a control in this app is a `Button`. */
  value?: string;
  /**
   * Which of a group is CHOSEN, for a button that is a toggle rather than an
   * action. It rides the element as `aria-pressed` because that state is
   * otherwise carried only by a colour, and a colour is not readable by
   * assistive tech, by a keyboard user's ear, or by a test. Absent — the
   * common case — emits no attribute at all: `aria-pressed="false"` on a plain
   * action button would announce it as an unpressed toggle.
   */
  pressed?: boolean;
} & ButtonAction;

/**
 * A button that is a button.
 *
 * Not a `div` with a click handler, and the difference is the whole of this
 * component: a `<button>` is focusable, is reachable by Tab, fires on Enter
 * and Space, is announced as a control, and carries a disabled state the
 * browser enforces. Every control in this app goes through here, so keyboard
 * access is a property of the app rather than a checklist item.
 */
export function Button(props: ButtonProps): JSX.Element {
  return (
    <button
      type={props.type ?? "button"}
      // `btn` is not the caller's to remember: the prop ADDS to it. It used to
      // REPLACE it, which made "every button carries `btn`" a convention four
      // of five callers restated by hand and a fifth could silently lose.
      class={props.class === undefined ? "btn" : `btn ${props.class}`}
      disabled={props.disabled}
      title={props.title}
      value={props.value}
      // `undefined` REMOVES the attribute and `false` writes `"false"`, which
      // is exactly the distinction `pressed` above is about.
      aria-pressed={props.pressed}
      onClick={props.onClick}
    >
      {props.children}
      <Hint text={props.title} />
    </button>
  );
}

/**
 * THE DRAWN HALF OF A `title`.
 *
 * The stylesheet shows `.tip` as a tooltip — styled, instant, and on
 * `:focus-visible` as well as on hover, so a keyboard user gets the
 * explanation a mouse user gets. `title` stays as the fallback where anchor
 * positioning is missing, and as what assistive tech reads.
 *
 * A CHILD ELEMENT, hidden from the accessibility tree, and its text in an
 * attribute rather than in the node. The first cut drew the hint as the
 * control's own `::after`, and generated content is part of an element's
 * accessible name — so the moment a button was hovered its name became
 * "Active read attempt 1 of…" and nothing that addressed it by name could
 * find it, the acceptance suite included.
 */
export function Hint(props: { text: string | undefined }): JSX.Element {
  return (
    <Show when={props.text !== undefined}>
      <span class="tip" aria-hidden="true" data-hint={props.text} />
    </Show>
  );
}

/** A labelled field. The `<label>` is bound by `for`, so clicking the words
 *  focuses the input and a screen reader announces the two together. */
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

/** One line of free text, bound to a signal. The autofill and autocorrect
 *  attributes are off because every one of these fields holds a path, a commit
 *  or a selector — strings a phone keyboard's helpfulness silently corrupts. */
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

/**
 * A SEARCH FIELD, with the magnifier in the box.
 *
 * `type="search"`, so the platform gives it a clear button and announces it as
 * a search box; the label is `aria-label` rather than visible text because
 * these sit in a toolbar where the placeholder already says what is searched.
 * The icon is `aria-hidden` — it is the second drawing of a word that is
 * already in the accessible name.
 */
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

/** A checkbox bound to a signal — `Toggle`'s box, and only that. */
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

/** A labelled checkbox — the box and its words in one `<label for>`, so the
 *  words toggle it and a screen reader announces them together. */
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

/**
 * A CHOICE WITH A SENTENCE UNDER IT — a radio drawn as the card it labels.
 *
 * For the handful of decisions where the OPTIONS need explaining and a
 * `<select>` would hide the explanation behind a click: which store a bucket's
 * objects live in is the one that exists today. Everything is inside the
 * `<label>`, so the sentence is part of the hit target and part of the
 * accessible name.
 */
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

/** A coloured pill — a state, a verdict, a count. `hue` is the semantic name,
 *  never a colour: the stylesheet decides what "red" looks like, and the same
 *  `hue-*` class family dresses the glyphs, the lane cells and the wire. */
export function Pill(props: { hue: StatusHue; children: JSX.Element }): JSX.Element {
  return <span class={`pill hue-${props.hue}`}>{props.children}</span>;
}

/**
 * A FACT THAT IS NOT A STATUS — a store's name, "public", a token's scope.
 *
 * Square and grey where a pill is round and coloured, and that distinction is
 * the design's one rule about colour made into two components: a verdict gets
 * a hue, a property does not. `hue` is accepted for the one tag that IS a
 * status — a bucket's domain being live — and is absent everywhere else.
 */
export function Tag(props: { hue?: StatusHue; children: JSX.Element }): JSX.Element {
  return (
    <span class={props.hue === undefined ? "tag" : `tag hue-${props.hue}`}>
      {props.children}
    </span>
  );
}

/** A number and what it counts. The number is mono because it is compared
 *  across cards; the word under it is read once. */
export function Stat(props: { value: JSX.Element; label: string }): JSX.Element {
  return (
    <div class="stat">
      <b>{props.value}</b>
      <span>{props.label}</span>
    </div>
  );
}

/**
 * A CARD WITH AN EDGE — the one surface this design has.
 *
 * `title` makes it a section with a heading and a hairline under it; without
 * one it is a plain bordered box. `actions` ride the head, right-aligned,
 * because a panel's controls belong to the panel and not to the page.
 */
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

/** A labelled value somebody copies — a substituter URL, a public key. */
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

/**
 * TAKE THIS STRING.
 *
 * `navigator.clipboard` is the whole implementation, and its refusal is drawn
 * rather than swallowed: a page served over plain HTTP on a tailnet name has
 * no clipboard at all, and a button that silently did nothing there would be
 * the worst control on the page. The label says what happened and goes back to
 * itself, so one button is its own receipt.
 *
 * `data-copy` rides the element because the acceptance suite counts the copy
 * controls a bucket page offers, and a count is the only way to assert "every
 * block a person pastes has one".
 */
export function CopyButton(props: { text: string; label?: string }): JSX.Element {
  const [said, setSaid] = createSignal<string | null>(null);
  let reset: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(reset));
  const press = (): void => {
    clearTimeout(reset);
    const clipboard = globalThis.navigator?.clipboard;
    if (clipboard === undefined) {
      // No secure context, no clipboard API. Said out loud rather than
      // swallowed: a board on a plain-HTTP tailnet name is a real deployment.
      setSaid("no clipboard");
      return;
    }
    void clipboard.writeText(props.text).then(
      () => setSaid("copied"),
      () => setSaid("refused"),
    );
    reset = setTimeout(() => setSaid(null), 1400);
  };
  return (
    <button type="button" class="btn copy" data-copy onClick={press}>
      {said() ?? props.label ?? "Copy"}
    </button>
  );
}

/**
 * ONE PLATFORM'S PIPELINE, AS CELLS — the signature element.
 *
 * One cell per node, in the order the pipeline declares them, with the lane's
 * short name in front. It is drawn on the board inside a list row and on a run
 * above that lane's nodes, and it is the same component both times: the same
 * eleven pixels mean the same thing wherever a person sees them.
 *
 * Every cell carries a `title`, because eleven pixels cannot say
 * `e2e-web@x86_64-linux, failed` — and `aria-hidden` on the strip would be
 * wrong (it is the only drawing of the pipeline on the board), so each cell is
 * an `<span role="img">` with a name.
 */
export interface LaneCell {
  /** What this cell is, in words: `fmt@x86_64-linux, passed`. */
  readonly label: string;
  /** The status hue, or `null` for a node nothing has happened to yet. */
  readonly hue: StatusHue | null;
  /** Skipped nodes are drawn as an absence with an edge rather than a colour:
   *  a skip is not a verdict about the work, it is the work not happening. */
  readonly skipped?: boolean;
}

export function LaneStrip(props: {
  /** The platform, shortened — `linux`, `darwin`. Empty for a single-lane run,
   *  where the label would be the only thing on the line. */
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

/** The way back, above a screen's head. A control and not an anchor, because
 *  this app's addresses are hash routes the shell owns. */
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

/**
 * A SCREEN'S HEAD — the title, one line of how it is doing, and the actions
 * that belong to the whole screen.
 *
 * `mono` is for a screen named by a string a machine chose (a bucket, a run):
 * that name is a thing you compare and paste, and setting it in the prose face
 * makes it look like a phrase.
 */
export function PageHead(props: {
  title: JSX.Element;
  mono?: boolean;
  sub?: JSX.Element;
  actions?: JSX.Element;
  /** Extra classes BESIDE `page-head`. One screen needs one — a run's header
   *  is also `detail-head`, which is how the acceptance suite addresses the
   *  outcome pill in it. */
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

/**
 * ARE YOU SURE — for the handful of controls that throw away work.
 *
 * A native `<dialog>` opened with `showModal()`, because the four behaviours a
 * confirmation needs are the four the platform already implements and a
 * hand-rolled overlay gets wrong one at a time: Esc closes it, the rest of the
 * page goes inert, focus is trapped inside it and returns to the trigger on
 * the way out, and the backdrop is the browser's own. A closed `<dialog>`
 * hides its subtree outright, so nothing in here is focusable or findable
 * while it is shut — which is what keeps it out of the keyboard sweep.
 *
 * `open` is a PROP rather than a method call, so the dialog's visibility is a
 * function of the caller's state and there is no second place where it can be
 * open. ONE EXIT, and the platform owns it: the buttons submit a
 * `<form method="dialog">`, the platform closes the dialog and records WHICH
 * button in `returnValue`, and the one `close` handler reads that and answers.
 * They used to call `onClose` themselves AND cause the effect to call
 * `el.close()`, so every button press invoked the caller's handler twice while
 * Esc invoked it once.
 *
 * **`confirmLabel` must never repeat the trigger's own words.** The acceptance
 * suite finds a control by its exact accessible name, and Playwright's strict
 * mode fails a locator that matches two elements — so a dialog whose confirm
 * button also says "Cancel run", opened by a button that says "Cancel run",
 * breaks every step that presses either one. Name the trigger for the thing
 * and the confirmation for the act.
 */
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
    // `close()` on a shut one fires a second `close` event. The verdict is
    // cleared on the way IN, so a dialog opened a second time cannot answer
    // with the button somebody pressed the first time.
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
        // THE ONE EXIT. Esc, the platform's own dismissal and both buttons all
        // arrive here; `returnValue` is which of them it was.
        if (dialog?.returnValue === "confirm") props.onConfirm();
        props.onClose();
      }}
    >
      <h2>{props.title}</h2>
      <p>{props.body}</p>
      {/* Cancel FIRST: the dialog focuses its first focusable child on open, so
          the button under the keyboard at the moment it appears is the one
          that changes nothing. */}
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

/**
 * WHAT A CONTROL ANSWERED — including a refusal.
 *
 * Every control in this app reports, because a control that went quiet on a
 * refusal is the browser's version of the failure this whole release removes.
 * The element is a `<p class="receipt">` and stays one: that is the selector
 * the acceptance suite reads an answer out of.
 *
 * ONE KNOB, because there is one fact underneath: was this an answer or a
 * refusal. How it is DRAWN and how it is ANNOUNCED both follow from that.
 * `status` waits for a screen reader to finish the sentence it is on, which is
 * right for "Told the coordinator to stop"; `alert` interrupts, which is right
 * for a refusal the person has to act on.
 */
export function Receipt(props: {
  /** An answer, or a refusal — the one fact underneath. */
  tone: "ok" | "refused";
  children: JSX.Element;
  /** Given only for a receipt somebody can be DONE with. A receipt that is
   *  still PENDING has none: the thing it describes has not happened yet. */
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
