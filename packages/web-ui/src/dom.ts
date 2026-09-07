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

import h from "solid-js/h";

/** A node, or something that produces one. Hyperscript's own return type is a
 *  thunk, so a composed view is a thunk too. */
export type View = unknown;

/** `h`, named for what it does at a call site. */
export const el = h;

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
export function button(opts: {
  label: string | (() => string);
  onClick: () => void;
  title?: string;
  disabled?: () => boolean;
  className?: string;
}): View {
  return el(
    "button",
    {
      type: "button",
      class: opts.className ?? "btn",
      onClick: opts.onClick,
      ...(opts.title === undefined ? {} : { title: opts.title }),
      ...(opts.disabled === undefined ? {} : { disabled: opts.disabled }),
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
