/**
 * The view primitives — the three controls every view here builds on.
 *
 * **Why JSX.** This package used to be written in Solid's hyperscript
 * (`solid-js/h`), and the argument for it was a build argument: JSX needs a
 * compiler, which needs a bundler plugin, which needs dependencies, in a tree
 * whose whole build was `Bun.build` over raw TypeScript. That is a real cost and
 * it is the wrong trade. A UI is read far more often than it is built, and
 * hyperscript made every view a nest of `el(...)` calls whose shape a reader had
 * to reconstruct before they could see the markup. The compiler now lives in
 * `scripts/build-web-ui.ts` as a `Bun.build` plugin and in the Nix derivation
 * that packages the browser bundle, so the page a user gets and the page a
 * developer builds are compiled by the same pinned toolchain — Nix stays the
 * only supported way to run odu, compiler included.
 *
 * **Solid's JSX is not React's, and the difference is the whole build.**
 * `babel-preset-solid` compiles each element to a cloned `<template>` plus one
 * effect per DYNAMIC binding: a component function runs ONCE, and only the
 * bindings that actually read a changed signal re-run. Bun's own built-in JSX
 * transform is not a substitute — it would emit `jsx(Component, props)` calls
 * with eagerly-evaluated props, which for Solid is a React-shaped render where
 * whole components re-run and every `createSignal` inside them is re-created.
 * That failure is invisible in a screenshot and invisible in a DOM snapshot; it
 * shows up as a page that loses its scroll position and its focus on every
 * frame. Hence a pinned preset (see the root manifest) rather than a convenient
 * default.
 *
 * **THE ONE RULE THE COMPILER CANNOT KEEP FOR YOU: never destructure props.**
 * `props` is an object of getters. `function Row({ run })` reads every one of
 * them once, at call time, and freezes the row. Write `props.run`, always, and
 * pass values rather than accessors — the compiler wraps a dynamic JSX
 * expression in a getter on the way in, so `<Row run={run()} />` stays as
 * fine-grained as handing `Row` the accessor would have been, and reads like
 * markup instead of like plumbing.
 *
 * **A note about `<Show>`, kept because it cost a day.** Under hyperscript this
 * file carried a `when()` helper, and it existed because of a real bug: Solid's
 * `Show` disposes a branch's computations the first time its condition goes
 * false, and a child handed over as a VALUE — built once, when the props object
 * was spelled — was then re-inserted DEAD when the condition came back true. The
 * symptom was opening run A, going back, opening run B, and reading A's header,
 * A's nodes and A's scope under B's address. Nothing about it is visible in a
 * DOM snapshot: the markup is well-formed, it is merely a page about a different
 * run than the one you asked for. In JSX that hazard is the compiler's problem
 * rather than a caller's: `<Show>`'s children compile to a `get children()`
 * accessor, so the branch is re-created on every re-entry. This is checked, not
 * assumed — `features/board.feature` opens one run, goes back, and opens
 * another.
 */

import { createEffect, Show, type JSX } from "solid-js";

/**
 * WHO acts when this button is pressed, and the two answers are exclusive.
 *
 * A plain button carries its own `onClick`. A `submit` button hands the action
 * to its form's `onSubmit` — and must NOT also carry a click handler, because
 * the browser fires both for one mouse press and the form would be submitted
 * twice. For a form that starts a CI run that is two runs, so the mistake is
 * made unspellable here rather than left to a comment: `onClick` is `never` on
 * the submit branch, and a caller that supplies both fails to compile.
 *
 * `submit` exists at all because it is the only way Enter-in-a-field reaches an
 * `onSubmit` handler. HTML's implicit submission gives up when a form has more
 * than one text field and no submit button, and the create form has five — so
 * while every control in this app was hardcoded `type="button"`, that form's
 * `onSubmit` was unreachable code and the form could not be operated from the
 * keyboard at all.
 */
type ButtonAction =
  | { type?: "button"; onClick: () => void }
  | { type: "submit"; onClick?: never };

export type ButtonProps = {
  children: JSX.Element;
  title?: string;
  disabled?: boolean;
  /** The class list, when it is not the default `btn`. */
  class?: string;
  /**
   * Which of a group is CHOSEN, for a button that is a toggle rather than an
   * action. It rides the element as `aria-pressed` because that state is
   * otherwise carried only by a colour, and a colour is not readable by
   * assistive tech, by a keyboard user's ear, or by a test. Absent — the common
   * case — emits no attribute at all: `aria-pressed="false"` on a plain action
   * button would announce it as an unpressed toggle.
   */
  pressed?: boolean;
} & ButtonAction;

/**
 * A button that is a button.
 *
 * Not a `div` with a click handler, and the difference is the whole of this
 * component: a `<button>` is focusable, is reachable by Tab, fires on Enter and
 * Space, is announced as a control, and carries a disabled state the browser
 * enforces. Every control in this app goes through here, so keyboard access is
 * a property of the app rather than a checklist item somebody has to remember
 * per control.
 */
export function Button(props: ButtonProps): JSX.Element {
  return (
    <button
      type={props.type ?? "button"}
      class={props.class ?? "btn"}
      disabled={props.disabled}
      title={props.title}
      // The SAME sentence, twice, on purpose. `data-hint` is what the stylesheet
      // draws as a tooltip — styled, instant, and shown on `:focus-visible` as
      // well as on hover, so a keyboard user gets the explanation a mouse user
      // gets. `title` stays because it is the fallback for every browser without
      // anchor positioning, and because assistive tech reads it: a `data-`
      // attribute is invisible to a screen reader.
      data-hint={props.title}
      // `undefined` REMOVES the attribute and `false` writes `"false"`, which is
      // exactly the distinction `pressed` above is about — an absent toggle
      // state versus a toggle that is off.
      aria-pressed={props.pressed}
      onClick={props.onClick}
    >
      {props.children}
    </button>
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

/** A coloured pill — a state, a verdict, a count. `hue` is the semantic name,
 *  never a colour: the stylesheet decides what "red" looks like. */
export function Pill(props: { hue: string; children: JSX.Element }): JSX.Element {
  return <span class={`pill pill-${props.hue}`}>{props.children}</span>;
}

/**
 * ARE YOU SURE — for the handful of controls that throw away work.
 *
 * A native `<dialog>` opened with `showModal()`, because the four behaviours a
 * confirmation needs are the four the platform already implements and a
 * hand-rolled overlay gets wrong one at a time: Esc closes it, the rest of the
 * page goes inert, focus is trapped inside it and returns to the trigger on the
 * way out, and the backdrop is the browser's own. A closed `<dialog>` hides its
 * subtree outright, so nothing in here is focusable, tabbable or findable while
 * it is shut — which is what keeps it out of the keyboard sweep.
 *
 * `open` is a PROP rather than a method call, so the dialog's visibility is a
 * function of the caller's state and there is no second place where it can be
 * open. The native `close` event — Esc, or the platform's own dismissal — is
 * wired back to `onClose`, so the two directions cannot drift apart.
 *
 * **`confirmLabel` must never repeat the trigger's own words.** The acceptance
 * suite finds a control by its exact accessible name, and Playwright's strict
 * mode fails a locator that matches two elements — so a dialog whose confirm
 * button also says "Cancel run", opened by a button that says "Cancel run",
 * breaks every step that presses either one. Name the trigger for the thing and
 * the confirmation for the act: "Cancel run" opens it, "Stop the run" commits.
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
    // `close()` on a shut one fires a second `close` event.
    if (props.open && !el.open) el.showModal();
    if (!props.open && el.open) el.close();
  });
  return (
    <dialog class="confirm" ref={dialog} onClose={() => props.onClose()}>
      <h2>{props.title}</h2>
      <p>{props.body}</p>
      {/* Cancel FIRST. The dialog focuses its first focusable child on open, so
          the button under the keyboard at the moment it appears is the one that
          changes nothing. */}
      <div class="confirm-actions">
        <Button onClick={() => props.onClose()}>{props.cancelLabel}</Button>
        <Button
          class={props.danger === true ? "btn btn-danger" : "btn"}
          onClick={() => {
            props.onConfirm();
            props.onClose();
          }}
        >
          {props.confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}

/**
 * WHAT A CONTROL ANSWERED — including a refusal.
 *
 * Every control in this app reports, because a control that went quiet on a
 * refusal is the browser's version of the failure this whole release removes.
 * The element is a `<p class="receipt">` and stays one: that is the selector the
 * acceptance suite reads an answer out of.
 *
 * `role` is the caller's, not this component's, and the two are different
 * promises. `status` is polite — it waits for a screen reader to finish the
 * sentence it is on, which is right for "Told the coordinator to stop". `alert`
 * interrupts, which is right for a refusal the person has to act on.
 *
 * The sentence is always wrapped in `.receipt-text`, even with no dismissal
 * beside it, so the receipt is one flex item that wraps as a paragraph rather
 * than a row of bare text nodes each shrinking to its longest word.
 */
export function Receipt(props: {
  role: "status" | "alert";
  bad?: boolean;
  children: JSX.Element;
  /** Given only for a receipt somebody may be done with. A refusal has no
   *  dismissal: it is the answer to what they just asked, and it goes when the
   *  next control answers. */
  onDismiss?: () => void;
}): JSX.Element {
  return (
    <p
      class="receipt"
      classList={{ "receipt-bad": props.bad === true }}
      role={props.role}
    >
      <span class="receipt-text">{props.children}</span>
      <Show when={props.onDismiss !== undefined}>
        <Button
          class="btn receipt-dismiss"
          title="clear this receipt"
          onClick={() => props.onDismiss?.()}
        >
          Dismiss
        </Button>
      </Show>
    </p>
  );
}
