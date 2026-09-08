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

import { createSignal, Show, type JSX } from "solid-js";
import { Button, Field } from "./dom";

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

/** One line of free text, bound to a signal. The autofill and autocorrect
 *  attributes are off because every one of these fields holds a path, a commit
 *  or a selector — strings a phone keyboard's helpfulness silently corrupts. */
function TextInput(props: {
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

export function Create(props: {
  state: CreateState;
  onStart: (form: StartForm) => void;
  onOpen: (runId: string) => void;
  onBack: () => void;
}): JSX.Element {
  const [checkout, setCheckout] = createSignal("");
  const [sha, setSha] = createSignal("");
  const [selectors, setSelectors] = createSignal("");
  const [platforms, setPlatforms] = createSignal("");
  const [hosts, setHosts] = createSignal("");
  const [noStrict, setNoStrict] = createSignal(false);
  const [noPost, setNoPost] = createSignal(false);
  const [supersede, setSupersede] = createSignal(false);

  const submit = (): void => {
    props.onStart({
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

  return (
    <section class="create">
      <header class="detail-head">
        <Button onClick={props.onBack}>← Runs</Button>
        <h1>New run</h1>
      </header>
      <form
        class="create-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field
          id="checkout"
          label="Checkout"
          hint="The ABSOLUTE path of the repository to run in. The service has no working directory of its own."
        >
          <TextInput
            id="checkout"
            value={checkout()}
            placeholder="/code/app"
            onValue={setCheckout}
          />
        </Field>
        <Field
          id="sha"
          label="Expected commit"
          hint="The commit you believe that checkout is on. A checkout that has moved on is refused, never run."
        >
          <TextInput
            id="sha"
            value={sha()}
            placeholder="a1b2c3d…"
            onValue={setSha}
          />
        </Field>
        <Field
          id="selectors"
          label="Recipes"
          hint={'Space-separated recipe[@platform] selectors. Empty means the whole [metadata("ci")] DAG.'}
        >
          <TextInput
            id="selectors"
            value={selectors()}
            placeholder="unit e2e"
            onValue={setSelectors}
          />
        </Field>
        <Field
          id="platforms"
          label="Platforms"
          hint="Empty means every platform in the fanout."
        >
          <TextInput
            id="platforms"
            value={platforms()}
            placeholder="x86_64-linux"
            onValue={setPlatforms}
          />
        </Field>
        <Field
          id="hosts"
          label="Host pins"
          hint="PLATFORM=ADDRESS, space-separated — the same spelling odu run --host takes."
        >
          <TextInput
            id="hosts"
            value={hosts()}
            placeholder="x86_64-linux=localhost"
            onValue={setHosts}
          />
        </Field>
        <fieldset class="toggles">
          <legend>Options</legend>
          <label class="toggle" for="no-strict">
            <CheckInput id="no-strict" checked={noStrict()} onChecked={setNoStrict} />
            Run the working tree as it stands (--no-strict)
          </label>
          <label class="toggle" for="no-post">
            <CheckInput id="no-post" checked={noPost()} onChecked={setNoPost} />
            Do not post GitHub commit statuses (--no-post)
          </label>
          <label class="toggle" for="supersede">
            <CheckInput id="supersede" checked={supersede()} onChecked={setSupersede} />
            Take the checkout from a run already live in it (--supersede)
          </label>
        </fieldset>
        {/* A SUBMIT button, and with no click handler of its own — see
            `./dom`'s `ButtonAction`. The form's `onSubmit` above is the single
            path a start takes, whether it was reached by a mouse or by Enter in
            a field, so the two ways of asking cannot disagree and one press
            cannot start two runs. */}
        <Button
          type="submit"
          class="btn btn-primary"
          disabled={props.state.kind === "starting"}
        >
          {props.state.kind === "starting" ? "Starting…" : "Start run"}
        </Button>
      </form>
      <Show when={props.state.kind === "refused" ? props.state : null}>
        {(refused) => (
          <p class="receipt receipt-bad" role="alert">
            {refused().message}
          </p>
        )}
      </Show>
      <Show when={props.state.kind === "existing" ? props.state : null}>
        {(existing) => (
          <p class="receipt" role="status">
            {`That checkout already has a live run at ${existing().sha.slice(0, 7)}. `}
            <Button onClick={() => props.onOpen(existing().runId)}>
              Open it
            </Button>
            {" — or tick “Take the checkout” above and start again."}
          </p>
        )}
      </Show>
    </section>
  );
}
