/**
 * WHICH THEME THIS BOARD IS IN — the one fact `./theme.css` reads, and the one
 * choice a person is allowed to make about how it looks.
 *
 * **Three states, not two.** `system` is the default and means exactly what it
 * says: `prefers-color-scheme` decides, and a desktop with no preference gets
 * dark, which is the look this product is designed in. `light` and `dark` are
 * PINS — a person reading a board beside a white editor, or one whose machine
 * is light and whose eyes are not. A two-state toggle would have no way back
 * to the machine's own answer, which is the state most people should be in.
 *
 * **The mechanism is `color-scheme` and nothing else.** Every colour in
 * `./theme.css` is one `light-dark(light, dark)` line; this module writes
 * `data-theme` on `<html>` and the stylesheet's three `:root` rules do the
 * rest. There is no second palette, no class per theme, and no component here
 * that knows a colour.
 *
 * **Written before the first paint.** The attribute is also set by a four-line
 * inline script in the shell's `<head>` (`packages/web-ui/src/index.html`),
 * because a module bundle runs after the first paint and a person who chose
 * light would otherwise see a black frame first. That script and this module
 * must agree on the key, so {@link THEME_KEY} is the value the shell is pinned
 * to by `packages/web-ui/src/theme.test.ts` — two restatements of one string,
 * held equal by a test rather than by a comment.
 */

import { createSignal, type JSX } from "solid-js";

/** `system` follows `prefers-color-scheme`; the other two pin it. */
export type Theme = "system" | "light" | "dark";

/** Where the choice is kept. Also spelled in the shell's boot script — see the
 *  module header for why, and for what holds the two equal. */
export const THEME_KEY = "odu.web.theme";

/** The cycle one press walks. System first, because that is where a person
 *  should be able to get back to. */
const NEXT: Record<Theme, Theme> = {
  system: "light",
  light: "dark",
  dark: "system",
};

/** What the button says it will leave you in. */
const LABEL: Record<Theme, string> = {
  system: "system",
  light: "light",
  dark: "dark",
};

function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * THE STORED CHOICE, or `system`.
 *
 * Every read of `localStorage` is guarded: a browser with storage denied (a
 * locked-down profile, Safari's private mode on an old build) throws on
 * ACCESS, not on the call, and a board that refuses to render because it could
 * not remember a colour would be a board nobody could use.
 */
export function readTheme(): Theme {
  try {
    const held = globalThis.localStorage?.getItem(THEME_KEY);
    return isTheme(held) ? held : "system";
  } catch {
    return "system";
  }
}

/**
 * PUT IT ON THE DOCUMENT, and remember it.
 *
 * `system` REMOVES the attribute rather than writing `data-theme="system"`:
 * the stylesheet's default `:root` rule is the follow-the-OS one, so absence
 * is the state, and a third selector for a third value would be a third place
 * to get the default wrong.
 */
export function applyTheme(theme: Theme): void {
  const root = globalThis.document?.documentElement;
  if (root !== undefined) {
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
  }
  try {
    if (theme === "system") globalThis.localStorage?.removeItem(THEME_KEY);
    else globalThis.localStorage?.setItem(THEME_KEY, theme);
  } catch {
    // A board that cannot remember the choice still honours it for this tab.
  }
}

/**
 * THE TOGGLE — one control, three states, and it says which one it is in.
 *
 * Self-contained because it is CHROME: no row needs to know the theme, and a
 * signal threaded through the shell for it would be a prop on every face.
 * The button's accessible name carries the state in words (`theme: dark`), so
 * what a screen reader hears and what a sighted person reads are one string.
 */
export function ThemeToggle(): JSX.Element {
  const [theme, setTheme] = createSignal<Theme>(readTheme());
  const press = (): void => {
    const next = NEXT[theme()];
    setTheme(next);
    applyTheme(next);
  };
  return (
    <button
      type="button"
      class="btn btn-quiet"
      // Not `aria-pressed`: this is not a toggle that is on or off, it is a
      // control that cycles, and announcing it as "pressed" would be a lie in
      // two of its three states.
      title="switch between the machine's theme, light and dark"
      onClick={press}
    >
      <span aria-hidden="true">{theme() === "light" ? "☀" : theme() === "dark" ? "☾" : "◐"}</span>
      theme: {LABEL[theme()]}
    </button>
  );
}
