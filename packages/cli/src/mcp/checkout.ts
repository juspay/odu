/**
 * The per-call `checkout` argument — one schema, one meaning, every bespoke
 * tool.
 *
 * `odu mcp` is spawned once by a harness and then serves MANY checkouts: a
 * supervising agent drives runs in whichever tree the conversation is about
 * while the server itself stays parked in one cwd. So every bespoke MCP tool
 * takes an optional `checkout` — the ABSOLUTE path of the checkout root (the
 * git top-level) the call targets — and everything follows from it: `run`
 * spawns its coordinator with `cwd: checkout` and waits on
 * `runSocketPath(checkout)`, and the read/drive verbs dial or read that
 * checkout's `.ci` per call.
 *
 * The DEFAULT is `process.cwd()` — the server's own working directory — so
 * every existing single-checkout agent (spawn the server in the checkout,
 * never send the argument) works exactly as before.
 *
 * Checkout means the ROOT, spelled as-is — not a subdirectory the caller hopes
 * git resolves. A run's `.ci` tree is rooted at the git top-level: the spawned
 * coordinator resolves its own toplevel from its spawn cwd and binds the
 * socket, lock, ledger and logs there, so a `checkout` that is not that
 * top-level points the whole kit at a `.ci` nobody serves. For `run` the miss
 * is worse than an error: the server spawns the coordinator in the subdirectory
 * (which binds the socket at the REAL toplevel) and then polls
 * `runSocketPath(checkout)` — a socket that never appears — and the detached,
 * unpollable coordinator that results is an orphan `cancel` cannot reach at
 * the path the caller holds. So `checkoutField` is not prose: it REFUSES a
 * string that is not absolute or whose `.git` entry (file OR directory — a
 * worktree's `.git` file counts) is absent, checked with `existsSync` alone —
 * no `realpath`, no `git rev-parse`, because every verb uses the string as-is
 * and the check must accept exactly the strings the verbs will use.
 *
 * RESOURCES ARE THE EXCEPTION, and it is deliberate: `nodes` /
 * `surface://collections/logs/{id}` are subscribable STREAMS the server
 * publishes, not calls with arguments, so they stay bound to the server's
 * home checkout (the projection's dial and its durable-log fallback are wired
 * once, at boot). Another checkout's run-state arrives through the verbs:
 * `wait_for_settle` returns the whole verdict for its `checkout`, `runs` the
 * durable history, and a node's log file is addressed off disk with
 * `@odu/run-client`'s `logPathFor` — the exported spelling exists precisely so
 * a cross-checkout reader never re-splices the layout by hand.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Schema } from "effect";
import { runSocketPath } from "@odu/run-client/dial";
import {
  dialAFor,
  redialingAClient,
} from "@odu/execution/coordinator/agentReader";

/** Is `s` usable as a checkout ROOT: absolute, with a `.git` entry — file OR
 *  directory, so a linked worktree (whose `.git` is a file) passes. One stat,
 *  no canonicalization, no git: the check vouches for exactly the strings the
 *  verbs use verbatim (spawn cwd, `runSocketPath`, `.ci` reads). */
function isCheckoutRoot(s: string): boolean {
  return isAbsolute(s) && existsSync(join(s, ".git"));
}

/** The one annotated field every bespoke tool's input struct carries. The
 *  `.annotate` description — not a JSDoc — is what a host shows an agent
 *  about the argument (see `waitInput`'s `expected_sha`). Ordering is
 *  load-bearing: the annotation must sit BEFORE the `makeFilter` check — an
 *  annotation applied after (or handed to the filter itself) never reaches
 *  the generated JSON Schema (measured; same placement law as surface-mcp's
 *  jsonschema divergence 4), and the filter node emits no constraint of its
 *  own. The `makeFilter` is the root rule above enforced at the ONE schema
 *  all nine tools share: a refusal here is a loud tool error, never a spawn
 *  the server won't poll (see the module header for the orphan-coordinator
 *  hazard it closes). */
export const checkoutField = Schema.optionalKey(
  Schema.String.check(Schema.isMinLength(1))
    .annotate({
      description:
        "Absolute path of the checkout root (git top-level) this call targets: " +
        "the directory whose `.ci` tree the run owns, validated — the path " +
        "must be absolute and its `.git` entry must exist. `run` spawns its " +
        "coordinator there and binds `<checkout>/.ci/odu.sock`; the read and " +
        "drive verbs dial that socket or read that `.ci`. Omit it for the " +
        "simple case: the call then targets this MCP server's own working " +
        "directory.",
    })
    .check(
      Schema.makeFilter(
        (checkout) =>
          isCheckoutRoot(checkout) ||
          `checkout must be the ABSOLUTE path of a checkout ROOT: '${checkout}' ` +
            "is not absolute or has no `.git` entry (file or directory). Pass " +
            "the git top-level; a subdirectory of a checkout is not accepted.",
      ),
    ),
);

/** The effective checkout for a call: the argument, or the server's cwd — the
 *  back-compat rule stated once. */
export function checkoutOf(input: { readonly checkout?: string }): string {
  return input.checkout ?? process.cwd();
}

/** The client a bespoke handler drives for a call, said ONCE for every
 *  dial-the-surface verb. Omitted `checkout`: the server-wired client (the
 *  HOME checkout's projection, bound at boot — see `mcp.ts`). Named
 *  `checkout`: a fresh re-dialing client bound to THAT checkout's socket —
 *  the same `redialingAClient(dialAFor(...))` pair the face itself is wired
 *  with, whose re-dial already happens per call; only the path becomes a
 *  function of the input.
 *
 *  `Face` is the handler's own narrow slice of the surface client (the few
 *  members it calls — `RerunClient`, `DriveClient`). Both casts live here so
 *  the `any` the bespoke slot hands the handler stops at this one boundary:
 *  the injected client is the face it was declared to be (the handler named
 *  it), and the per-call client is the full surface client, from which any
 *  such slice narrows. */
export function clientForCheckout<Face>(
  checkout: string | undefined,
  injected: unknown,
): Face {
  return (
    checkout === undefined
      ? injected
      : redialingAClient(dialAFor(runSocketPath(checkout)))
  ) as Face;
}
