/**
 * THE COMMIT A RUN TESTED — the one piece of markup this row owns that is not
 * a screen.
 *
 * Everything else that used to live beside it moved out. `Button`, `Hint`,
 * `Field`, `TextInput`, `Toggle`, `Pill`, `Confirm` and `Receipt` are not
 * facts about runs: they are what a control IS in this application, and two
 * rows drawing their own would be two answers to that. They live in
 * `@odu/face/ui` now — the package of no row — and this file is what was left
 * when they went: the `<sha7>#<seq>` ref and the `+dirty` marker, which are
 * about a RUN and belong to the row that owns runs.
 *
 * It stays a component rather than a string from `./format` because the dirty
 * marker is a drawn thing with a class of its own, and because the board row
 * and the run header name the same fact — they used to draw it with two sets
 * of markup and two byte-identical rules.
 *
 * The Solid rules every view here keeps (never destructure props; a `<Show>`'s
 * children are a getter, which is what makes a branch re-buildable after it
 * has gone false) are documented once, in `@odu/face`'s `ui.tsx` header, and
 * checked by `./compile.test.ts` against the compiler that actually ships.
 */

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
