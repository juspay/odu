import type { Effect } from "effect";
import { createSignal, onCleanup } from "solid-js";
import { refusalText } from "./refusal";

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
   *  `after` runs on either answer. */
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
