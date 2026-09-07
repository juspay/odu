/**
 * STARTING A RUN from the browser.
 *
 * Two fields are required and neither has a default, which is the whole design
 * of this form:
 *
 *   - **The checkout is explicit.** An absolute path, typed or pasted. The
 *     service has no cwd to fall back on and must not acquire one: a web page
 *     that could start a run "here" would be a page whose meaning depends on
 *     which process happens to be serving it.
 *   - **The commit is explicit.** `expectedSha` is what the caller BELIEVES the
 *     checkout is on, and a checkout that has moved on is refused rather than
 *     run. Without it, "start a run" quietly means "run whatever is checked out
 *     right now", which is how a run of the wrong commit gets reported as a run
 *     of the right one.
 *
 * The refusal is the feature. Every way this can fail — not a repository, a
 * commit that moved, a checkout that already has a live run — comes back as a
 * sentence with a recovery, and the form shows it rather than clearing itself.
 */

import { createSignal, Show } from "solid-js";
import { button, el, field, type View } from "./dom";

/** What the caller filled in. Every optional field is left ABSENT rather than
 *  sent empty: the wire's optional keys mean "not said", and an empty array
 *  would be a caller asserting "no selectors" where they meant "I did not
 *  choose". */
export interface StartForm {
  checkout: string;
  expectedSha: string;
  selectors: string[];
  platforms: string[];
  hostPins: string[];
  noStrict: boolean;
  noPost: boolean;
  supersede: boolean;
}

/** What the form is doing. `existing` is not an error: the caller asked for a
 *  checkout that already has a live run, and being shown that run is almost
 *  certainly what they wanted. */
export type CreateState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "started"; runId: string }
  | { kind: "existing"; runId: string; sha: string }
  | { kind: "refused"; message: string };

/** Split a space-separated field into tokens, dropping the empties a person's
 *  trailing space leaves behind. */
function tokens(raw: string): string[] {
  return raw.split(/\s+/).filter((token) => token !== "");
}

export function create(opts: {
  state: () => CreateState;
  onStart: (form: StartForm) => void;
  onOpen: (runId: string) => void;
  onBack: () => void;
}): View {
  const [checkout, setCheckout] = createSignal("");
  const [sha, setSha] = createSignal("");
  const [selectors, setSelectors] = createSignal("");
  const [platforms, setPlatforms] = createSignal("");
  const [hosts, setHosts] = createSignal("");
  const [noStrict, setNoStrict] = createSignal(false);
  const [noPost, setNoPost] = createSignal(false);
  const [supersede, setSupersede] = createSignal(false);

  const submit = (): void => {
    opts.onStart({
      checkout: checkout().trim(),
      expectedSha: sha().trim(),
      selectors: tokens(selectors()),
      platforms: tokens(platforms()),
      hostPins: tokens(hosts()),
      noStrict: noStrict(),
      noPost: noPost(),
      supersede: supersede(),
    });
  };

  const text = (
    id: string,
    value: () => string,
    set: (v: string) => void,
    placeholder: string,
  ): View =>
    el("input", {
      id,
      type: "text",
      class: "input",
      value,
      placeholder,
      spellcheck: "false",
      autocapitalize: "off",
      autocorrect: "off",
      onInput: (event: Event) =>
        set((event.currentTarget as HTMLInputElement).value),
    });

  const check = (id: string, on: () => boolean, set: (v: boolean) => void): View =>
    el("input", {
      id,
      type: "checkbox",
      checked: on,
      onChange: (event: Event) =>
        set((event.currentTarget as HTMLInputElement).checked),
    });

  return el(
    "section",
    { class: "create" },
    el(
      "header",
      { class: "detail-head" },
      button({ label: "← Runs", onClick: opts.onBack }),
      el("h1", {}, "New run"),
    ),
    el(
      "form",
      {
        class: "create-form",
        onSubmit: (event: Event) => {
          event.preventDefault();
          submit();
        },
      },
      field({
        id: "checkout",
        label: "Checkout",
        hint: "The ABSOLUTE path of the repository to run in. The service has no working directory of its own.",
        input: text("checkout", checkout, setCheckout, "/code/app"),
      }),
      field({
        id: "sha",
        label: "Expected commit",
        hint: "The commit you believe that checkout is on. A checkout that has moved on is refused, never run.",
        input: text("sha", sha, setSha, "a1b2c3d…"),
      }),
      field({
        id: "selectors",
        label: "Recipes",
        hint: "Space-separated recipe[@platform] selectors. Empty means the whole [metadata(\"ci\")] DAG.",
        input: text("selectors", selectors, setSelectors, "unit e2e"),
      }),
      field({
        id: "platforms",
        label: "Platforms",
        hint: "Empty means every platform in the fanout.",
        input: text("platforms", platforms, setPlatforms, "x86_64-linux"),
      }),
      field({
        id: "hosts",
        label: "Host pins",
        hint: "PLATFORM=ADDRESS, space-separated — the same spelling odu run --host takes.",
        input: text("hosts", hosts, setHosts, "x86_64-linux=localhost"),
      }),
      el(
        "fieldset",
        { class: "toggles" },
        el("legend", {}, "Options"),
        el(
          "label",
          { class: "toggle", for: "no-strict" },
          check("no-strict", noStrict, setNoStrict),
          "Run the working tree as it stands (--no-strict)",
        ),
        el(
          "label",
          { class: "toggle", for: "no-post" },
          check("no-post", noPost, setNoPost),
          "Do not post GitHub commit statuses (--no-post)",
        ),
        el(
          "label",
          { class: "toggle", for: "supersede" },
          check("supersede", supersede, setSupersede),
          "Take the checkout from a run already live in it (--supersede)",
        ),
      ),
      button({
        label: () =>
          opts.state().kind === "starting" ? "Starting…" : "Start run",
        onClick: submit,
        disabled: () => opts.state().kind === "starting",
        className: "btn btn-primary",
      }),
    ),
    el(Show, {
      when: () => opts.state().kind === "refused",
      children: el("p", { class: "receipt receipt-bad", role: "alert" }, () => {
        const state = opts.state();
        return state.kind === "refused" ? state.message : "";
      }),
    }),
    el(Show, {
      when: () => opts.state().kind === "existing",
      children: el(
        "p",
        { class: "receipt", role: "status" },
        () => {
          const state = opts.state();
          return state.kind === "existing"
            ? `That checkout already has a live run at ${state.sha.slice(0, 7)}. `
            : "";
        },
        button({
          label: "Open it",
          onClick: () => {
            const state = opts.state();
            if (state.kind === "existing") opts.onOpen(state.runId);
          },
        }),
        " — or tick “Take the checkout” above and start again.",
      ),
    }),
  );
}
