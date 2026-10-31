/**
 * ONE CONTROL'S STORY — idle, busy, then an answer or a refusal — for every
 * row's face.
 *
 * Three faces spelled this machine three times (the runs' operations, a
 * bucket's administration, the people page), each with its own copy of the
 * refusal-to-sentence rule. It is here, in a package of no row, because it is
 * no row's idea — and not in `@odu/cordis`, the contract every server-side
 * row loads, because a UI runtime is not vocabulary host and rows share.
 *
 * **A factory, not a store.** Each call makes its own signals inside the
 * caller's owner, and `onCleanup` retires it with that owner — so an answer
 * that lands after the control's page closed writes nowhere, and nothing is
 * module-level. That is what lets it cross a package boundary safely.
 *
 * The crossing from a description to execution stays the SHELL's: `call` is
 * the page's one edge, handed in, never `Effect.runPromise` here.
 */

import type { Effect } from "effect";
import { createSignal, onCleanup } from "solid-js";
import { refusalText } from "./refusal";

/** What a control is doing. `ok` and `refused` carry the sentence to show. */
export type ControlState =
  | { readonly kind: "idle" }
  | { readonly kind: "busy" }
  | { readonly kind: "ok"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string };

export interface Control {
  readonly state: () => ControlState;
  readonly busy: () => boolean;
  /** The refusal's sentence, or null. */
  readonly fault: () => string | null;
  /** The answer's sentence, or null. */
  readonly done: () => string | null;
  /** Run one call: busy, then `ok(value)`'s sentence or the refusal's.
   *  `after` runs on either answer — a re-read, so a page says what is true
   *  whether or not the change landed. */
  readonly run: <A>(
    effect: Effect.Effect<A, unknown>,
    ok: (value: A) => string,
    after?: () => void,
  ) => void;
}

export function createControl(
  call: <A>(effect: Effect.Effect<A, unknown>) => Promise<A>,
): Control {
  const [state, setState] = createSignal<ControlState>({ kind: "idle" });
  let live = true;
  onCleanup(() => {
    live = false;
  });
  return {
    state,
    busy: () => state().kind === "busy",
    fault: () => {
      const now = state();
      return now.kind === "refused" ? now.message : null;
    },
    done: () => {
      const now = state();
      return now.kind === "ok" ? now.message : null;
    },
    run: (effect, ok, after) => {
      setState({ kind: "busy" });
      void call(effect).then(
        (value) => {
          if (!live) return;
          setState({ kind: "ok", message: ok(value) });
          after?.();
        },
        (err: unknown) => {
          if (!live) return;
          setState({ kind: "refused", message: refusalText(err) });
          after?.();
        },
      );
    },
  };
}
