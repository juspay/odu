# @odu/face

What every row's **face** shares, and nothing a server needs. In **no row**,
after [`@odu/credentials`](../credentials/README.md)'s precedent: two or more
rows import it and none owns it.

| door | what | consumers |
| --- | --- | --- |
| `./control` | `createControl(call)` — one control's story: idle, busy, then an answer or a refusal | `@odu/cache/face`, `@odu/auth/face`, `@odu/ci/face` |
| `./refusal` | `refusalText(err)` — a refusal as the sentence a person reads, with the recovery when it carries one | the same three |

**A factory, not a store.** Each `createControl` makes its own signals inside
the caller's owner, and `onCleanup` retires it with that owner — an answer
that lands after the control's page closed writes nowhere, and nothing is
module-level. That is what lets it cross a package boundary.

**The edge stays the shell's.** A control is handed `call`, the page's one
`Effect.runPromise`; this package never runs an `Effect` itself.

**Why not `@odu/cordis`.** Cordis is the contract the host and every
server-side row load; a reactive UI helper is not vocabulary they share, and
putting one there put `solid-js` in every server's manifest. Cordis's closure
test now refuses a UI runtime; this package's own pins `effect` and
`solid-js` and refuses any `@odu/*` import.
