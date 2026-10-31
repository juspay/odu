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
 *
 * **Every option `run.start` takes is a field here**, because the board does
 * everything `odu run` does: selectors, platforms, host pins, the justfile
 * root, no-deps, no-strict, no-post, supersede, linger and the hosts file. And
 * `pipeline.read` sits beside them as **Preview pipeline** — `odu dump` for the
 * checkout typed above, so a person sees what a start would run before it runs.
 */

import { createSignal, For, Show, type JSX } from "solid-js";
import { Button, Field, Receipt, TextInput, Toggle } from "./dom";
import type { Pipeline } from "./types";

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
  /** `--root NAMEPATH`: which justfile module the DAG is read from. */
  root: string;
  /** The service's `$ODU_HOSTS` reading — empty means "use the service's own". */
  hostsFile: string;
  noDeps: boolean;
  noStrict: boolean;
  noPost: boolean;
  supersede: boolean;
  linger: boolean;
}

/** What the pipeline preview is showing. */
export type PreviewState =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "read"; pipeline: Pipeline }
  | { kind: "refused"; message: string };

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

export function Create(props: {
  state: CreateState;
  onStart: (form: StartForm) => void;
  /** `pipeline.read` for the checkout and root typed so far. A READ, so it is
   *  offered to anyone who may see the board. */
  preview: PreviewState;
  onPreview: (checkout: string, root: string) => void;
  /** The runs' floor is `member`; a principal below it may read a run and not
   *  start one, so the submit is not drawn at all. */
  canRun: boolean;
  onOpen: (runId: string) => void;
  onBack: () => void;
}): JSX.Element {
  const [checkout, setCheckout] = createSignal("");
  const [sha, setSha] = createSignal("");
  const [selectors, setSelectors] = createSignal("");
  const [platforms, setPlatforms] = createSignal("");
  const [hosts, setHosts] = createSignal("");
  const [root, setRoot] = createSignal("");
  const [hostsFile, setHostsFile] = createSignal("");
  const [noDeps, setNoDeps] = createSignal(false);
  const [noStrict, setNoStrict] = createSignal(false);
  const [noPost, setNoPost] = createSignal(false);
  const [supersede, setSupersede] = createSignal(false);
  const [linger, setLinger] = createSignal(false);

  const submit = (): void => {
    props.onStart({
      checkout: checkout().trim(),
      expectedSha: sha().trim(),
      selectors: tokens(selectors()),
      platforms: tokens(platforms()),
      hostPins: tokens(hosts()),
      root: root().trim(),
      hostsFile: hostsFile().trim(),
      noDeps: noDeps(),
      noStrict: noStrict(),
      noPost: noPost(),
      supersede: supersede(),
      linger: linger(),
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
        <Field
          id="root"
          label="Justfile root"
          hint="A module path inside the justfile — the same NAMEPATH odu run --root takes. Empty means the top."
        >
          <TextInput id="root" value={root()} placeholder="ci" onValue={setRoot} />
        </Field>
        <Field
          id="hosts-file"
          label="Hosts file"
          hint="An absolute path to the hosts file to resolve platforms from. Empty means the service's own."
        >
          <TextInput
            id="hosts-file"
            value={hostsFile()}
            placeholder="/etc/odu/hosts.json"
            onValue={setHostsFile}
          />
        </Field>
        <fieldset class="toggles">
          <legend>Options</legend>
          <Toggle id="no-deps" checked={noDeps()} onChecked={setNoDeps}>
            Run only the named recipes, not what they need (--no-deps)
          </Toggle>
          <Toggle id="no-strict" checked={noStrict()} onChecked={setNoStrict}>
            Run the working tree as it stands (--no-strict)
          </Toggle>
          <Toggle id="no-post" checked={noPost()} onChecked={setNoPost}>
            Do not post GitHub commit statuses (--no-post)
          </Toggle>
          <Toggle id="supersede" checked={supersede()} onChecked={setSupersede}>
            Take the checkout from a run already live in it (--supersede)
          </Toggle>
          <Toggle id="linger" checked={linger()} onChecked={setLinger}>
            Keep the run answerable after it settles (linger)
          </Toggle>
        </fieldset>
        {/* A READ, beside the submit rather than instead of it: what this
            checkout would run, before anything runs. */}
        <Button onClick={() => props.onPreview(checkout().trim(), root().trim())}>
          {props.preview.kind === "reading" ? "Reading…" : "Preview pipeline"}
        </Button>
        {/* A SUBMIT button, and with no click handler of its own — see
            `./dom`'s `ButtonAction`. The form's `onSubmit` above is the single
            path a start takes, whether it was reached by a mouse or by Enter in
            a field, so the two ways of asking cannot disagree and one press
            cannot start two runs. */}
        <Show when={props.canRun}>
          <Button
            type="submit"
            class="btn-primary"
            disabled={props.state.kind === "starting"}
          >
            {props.state.kind === "starting" ? "Starting…" : "Start run"}
          </Button>
        </Show>
      </form>
      {/* A refusal INTERRUPTS — `Receipt`'s `refused` tone announces it with
          `alert` rather than `status` — because it is the answer to the thing
          the person just pressed, and the form is still sitting there looking
          ready.

          NEITHER receipt here is dismissable, unlike the run page's. There is
          nothing to be stuck with: this form's one control replaces its answer
          the moment it is pressed again, so a Dismiss button would be a second
          way to clear something one press already clears. */}
      <Show when={props.preview.kind === "refused" ? props.preview : null}>
        {(refused) => <Receipt tone="refused">{refused().message}</Receipt>}
      </Show>
      <Show when={props.preview.kind === "read" ? props.preview.pipeline : null}>
        {(pipeline) => (
          <section class="admin-section pipeline-preview" aria-label="pipeline">
            <h3>{`${pipeline().name}: ${pipeline().tasks.length} recipes`}</h3>
            <ul class="tokens">
              <For each={pipeline().tasks}>
                {(task) => (
                  <li>
                    <span>
                      <code>{task.id}</code>
                      <Show when={task.needs.length > 0}>
                        <span class="hint">{` needs ${task.needs.join(", ")}`}</span>
                      </Show>
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </section>
        )}
      </Show>
      <Show when={props.state.kind === "refused" ? props.state : null}>
        {(refused) => <Receipt tone="refused">{refused().message}</Receipt>}
      </Show>
      <Show when={props.state.kind === "existing" ? props.state : null}>
        {(existing) => (
          <Receipt tone="ok">
            {`That checkout already has a live run at ${existing().sha.slice(0, 7)}. `}
            <Button onClick={() => props.onOpen(existing().runId)}>
              Open it
            </Button>
            {" — or tick “Take the checkout” above and start again."}
          </Receipt>
        )}
      </Show>
    </section>
  );
}
