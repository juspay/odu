import { createSignal, For, Show, type JSX } from "solid-js";
import {
  BackLink,
  Button,
  Field,
  PageHead,
  Panel,
  Receipt,
  TextInput,
  Toggle,
} from "@odu/face/ui";
import type { Pipeline } from "./types";

export interface StartForm {
  checkout: string;
  expectedSha: string;
  selectors: string[];
  platforms: string[];
  hostPins: string[];
  root: string;
  hostsFile: string;
  noDeps: boolean;
  noStrict: boolean;
  noPost: boolean;
  supersede: boolean;
  linger: boolean;
}

export type PreviewState =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "read"; pipeline: Pipeline }
  | { kind: "refused"; message: string };

export type CreateState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "started"; runId: string }
  | { kind: "existing"; runId: string; sha: string }
  | { kind: "refused"; message: string };

function tokens(raw: string): string[] {
  return raw.split(/\s+/).filter((token) => token !== "");
}

export function Create(props: {
  state: CreateState;
  onStart: (form: StartForm) => void;
  preview: PreviewState;
  onPreview: (checkout: string, root: string) => void;
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
    <section class="screen create">
      <BackLink onClick={props.onBack}>All runs</BackLink>
      <PageHead
        title="New run"
        sub="Every option odu ci run takes, and the refusal is the feature: a checkout that has moved on is declined rather than run."
      />
      <form
        class="form"
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
        <div class="form-pair">
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
        </div>
        <Field
          id="hosts"
          label="Host pins"
          hint="PLATFORM=ADDRESS, space-separated — the same spelling odu ci run --host takes."
        >
          <TextInput
            id="hosts"
            value={hosts()}
            placeholder="x86_64-linux=localhost"
            onValue={setHosts}
          />
        </Field>
        <div class="form-pair">
          <Field
            id="root"
            label="Justfile root"
            hint="A module path inside the justfile — the same NAMEPATH odu ci run --root takes. Empty means the top."
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
        </div>
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
        <div class="control-row">
          <Button onClick={() => props.onPreview(checkout().trim(), root().trim())}>
            {props.preview.kind === "reading" ? "Reading…" : "Preview pipeline"}
          </Button>
          <Show when={props.canRun}>
            <Button
              type="submit"
              class="btn-primary"
              disabled={props.state.kind === "starting"}
            >
              {props.state.kind === "starting" ? "Starting…" : "Start run"}
            </Button>
          </Show>
        </div>
      </form>
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
      <Show when={props.preview.kind === "refused" ? props.preview : null}>
        {(refused) => <Receipt tone="refused">{refused().message}</Receipt>}
      </Show>
      <Show when={props.preview.kind === "read" ? props.preview.pipeline : null}>
        {(pipeline) => (
          <Panel
            class="pipeline-preview"
            label="pipeline"
            title={`${pipeline().name}: ${pipeline().tasks.length} recipes`}
          >
            <div class="panel-body">
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
            </div>
          </Panel>
        )}
      </Show>
    </section>
  );
}
