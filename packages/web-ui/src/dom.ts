/**
 * The view primitives — Solid's hyperscript, and the three helpers every view
 * here uses.
 *
 * **Why hyperscript and not JSX.** Solid's fine-grained JSX needs a compiler
 * plugin, which needs a bundler plugin, which needs a bundler config, which
 * needs two more npm dependencies in a tree whose whole build is `Bun.build`
 * over raw TypeScript. `solid-js/h` is Solid's own supported no-build mode: the
 * same reactive runtime, the same fine-grained updates, and one import. The
 * cost is the one rule below, and it is a rule a reviewer can check by eye.
 *
 * **THE RULE: a dynamic value is a FUNCTION.** `el("span", {}, count())` reads
 * the signal once, at construction, and never again. `el("span", {}, () =>
 * count())` is reactive. That is not a quirk of this file — it is how
 * hyperscript distinguishes a value from a computation, and it is the same
 * distinction JSX's compiler makes invisibly. Every dynamic read below is
 * therefore a thunk, and a static one deliberately is not.
 */

import { Show } from "solid-js";
import h from "solid-js/h";

/** A node, or something that produces one. Hyperscript's own return type is a
 *  thunk, so a composed view is a thunk too. */
export type View = unknown;

/** `h`, named for what it does at a call site. */
export const el = h;

/**
 * A conditional branch. Every one in this app goes through here.
 *
 * `build` is a FUNCTION, and that is the entire reason this helper exists.
 * Solid's `Show` calls a child function only when the function DECLARES a
 * parameter; a child handed over as a value is built once, when the props object
 * is spelled, and the computations inside it end up owned by the memo that
 * inserts it. So the first time the condition goes false they are disposed — and
 * when it comes back true, those same, now-dead nodes are re-inserted.
 *
 * The result is a branch that renders correctly, disappears correctly, and then
 * returns FROZEN at whatever it last showed. That is not a hazard somebody
 * imagined: it is how opening one run, going back to the board and opening a
 * second run left the detail view sitting on the FIRST run's header, nodes and
 * scope while the address bar named the second. Nothing about it is visible in a
 * DOM snapshot — the markup is well-formed, it is merely a page about a
 * different run than the one you asked for.
 *
 * The parameter below is declared and ignored on purpose: its PRESENCE is the
 * thing Solid checks, so writing `() => …` here would silently restore the bug.
 */
export function when(cond: () => boolean, build: () => View): View {
  return el(Show, { when: cond, children: (_shown: unknown) => build() });
}

/**
 * Class names from a record of conditions.
 *
 * Returns a STRING, so a caller that wants it reactive passes `() =>
 * classes({…})` — the rule above, applied. Written as a helper because the
 * alternative is a template literal per element with a ternary inside it, which
 * is where a stray `false` ends up in the DOM as the word "false".
 */
export function classes(spec: Record<string, boolean>): string {
  return Object.entries(spec)
    .filter(([, on]) => on)
    .map(([name]) => name)
    .join(" ");
}

/**
 * A button that is a button.
 *
 * Not a `div` with a click handler, and the difference is the whole of this
 * function: a `<button>` is focusable, is reachable by Tab, fires on Enter and
 * Space, is announced as a control, and carries a disabled state the browser
 * enforces. Every control in this app goes through here, so keyboard access is
 * a property of the app rather than a checklist item somebody has to remember
 * per control.
 */
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

export function button(
  opts: {
    label: string | (() => string);
    title?: string;
    disabled?: () => boolean;
    className?: string;
    /**
     * Which of a group is CHOSEN, for a button that is a toggle rather than an
     * action. It rides the element as `aria-pressed` because that state is
     * otherwise carried only by a colour, and a colour is not readable by
     * assistive tech, by a keyboard user's ear, or by a test. Absent — the
     * common case — emits no attribute at all: `aria-pressed="false"` on a
     * plain action button would announce it as an unpressed toggle.
     */
    pressed?: () => boolean;
  } & ButtonAction,
): View {
  return el(
    "button",
    {
      type: opts.type ?? "button",
      class: opts.className ?? "btn",
      ...(opts.onClick === undefined ? {} : { onClick: opts.onClick }),
      ...(opts.title === undefined ? {} : { title: opts.title }),
      ...(opts.disabled === undefined ? {} : { disabled: opts.disabled }),
      // A THUNK, per this file's rule: the pressed one moves as a person
      // clicks, and a value read here would be read once and never again.
      ...(opts.pressed === undefined
        ? {}
        : { "aria-pressed": () => String(opts.pressed?.() ?? false) }),
    },
    typeof opts.label === "string" ? opts.label : () => opts.label,
  );
}

/** A labelled field. The `<label>` is bound by `for`, so clicking the words
 *  focuses the input and a screen reader announces the two together. */
export function field(opts: {
  id: string;
  label: string;
  hint?: string;
  input: View;
}): View {
  return el(
    "div",
    { class: "field" },
    el("label", { for: opts.id }, opts.label),
    opts.input,
    opts.hint === undefined
      ? null
      : el("p", { class: "hint" }, opts.hint),
  );
}

/** A coloured pill — a state, a verdict, a count. `hue` is the semantic name,
 *  never a colour: the stylesheet decides what "red" looks like. */
export function pill(hue: string, label: string | (() => string)): View {
  return el(
    "span",
    { class: `pill pill-${hue}` },
    typeof label === "string" ? label : () => label,
  );
}
