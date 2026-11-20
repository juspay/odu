import { createSignal, type JSX } from "solid-js";

export type Theme = "system" | "light" | "dark";

export const THEME_KEY = "odu.web.theme";

const NEXT: Record<Theme, Theme> = {
  system: "light",
  light: "dark",
  dark: "system",
};

const LABEL: Record<Theme, string> = {
  system: "system",
  light: "light",
  dark: "dark",
};

function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * Every read of `localStorage` is guarded: a browser with storage denied (a
 * locked-down profile, Safari's private mode on an old build) throws on
 * ACCESS, not on the call.
 */
export function readTheme(): Theme {
  try {
    const held = globalThis.localStorage?.getItem(THEME_KEY);
    return isTheme(held) ? held : "system";
  } catch {
    return "system";
  }
}

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
  }
}

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
      title="switch between the machine's theme, light and dark"
      onClick={press}
    >
      <span aria-hidden="true">{theme() === "light" ? "☀" : theme() === "dark" ? "☾" : "◐"}</span>
      theme: {LABEL[theme()]}
    </button>
  );
}
