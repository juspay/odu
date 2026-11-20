import { Show, type JSX } from "solid-js";
import { runRef } from "./format";

export function CommitRef(props: {
  sha: string;
  seq: number | null;
  dirty: boolean;
  contentSha?: string;
}): JSX.Element {
  return (
    <>
      {runRef(props.sha, props.seq)}
      <Show when={props.dirty}>
        <span class="dirty">
          +dirty<Show when={props.contentSha}>→{props.contentSha?.slice(0, 7)}</Show>
        </span>
      </Show>
    </>
  );
}
