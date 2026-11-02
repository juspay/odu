# @odu/face

What every row's **face** shares, and nothing a server needs. In **no row**,
after [`@odu/credentials`](../credentials/README.md)'s precedent: two or more
rows import it and none owns it.

| door | what | consumers |
| --- | --- | --- |
| `./theme.css` | **Night shift** — the tokens, the base, every primitive's look, and the page shell every screen sits in | the bundle, through `scripts/build-web-ui.ts` |
| `./theme` | `ThemeToggle`, `THEME_KEY`, `readTheme`, `applyTheme` — which of the two schemes is showing, and remembering it | `@odu/web-ui` (the shell) |
| `./ui` | the primitives: `Button` `Field` `TextInput` `SearchInput` `Toggle` `Choice` `Pill` `Tag` `Stat` `Panel` `KeyValue` `CopyButton` `LaneStrip` `BackLink` `PageHead` `Confirm` `Receipt`, and `StatusHue` | every row's face, and the shell |
| `./control` | `createControl(call)` — one control's story: idle, busy, then an answer or a refusal | `@odu/cache/face`, `@odu/auth/face`, `@odu/ci/face` |
| `./refusal` | `refusalText(err)` — a refusal as the sentence a person reads, with the recovery when it carries one | the same three |

**One vocabulary, and only the shared half of it.** A component here is markup
and semantics only — not one of them names a colour, a size or a layout. The
agreement between `./ui` and `./theme.css` is a class name.

**A row's own screens are NOT here.** `theme.css` carries the tokens, the
primitives and the page shell; what only one row has — the board's seven
columns, the node list's Gantt, the console, the sign-in field — lives in that
row's own `face.css`, beside the view that emits the class names. Otherwise
this package would change every time any row's screens did.
`scripts/build-web-ui.ts` finds every `packages/<row>/src/**/face.css`, appends
it here in path order and ships one hashed asset; the four `@layer` names this
file declares are what keeps the order of that concatenation from deciding
which rule wins.

**Colour carries status, and nothing else.** Green passed, amber running, red
failed, violet errored, cyan link or selection. `Pill` is a verdict and takes
a hue; `Tag` is a property and does not. A status is never carried by hue
alone: every pill's marker differs in SHAPE, and every lane cell has a name.

**Dark by default, light from the same tokens.** Every colour is one
`light-dark(light, dark)` line and `color-scheme` picks the half, so the two
themes cannot drift apart. `:root` with no `data-theme` follows the OS; the
toggle pins it and remembers. The shell's `<head>` writes the attribute before
the first paint, which is why `THEME_KEY` is exported and pinned by
`packages/web-ui/src/theme.test.ts`.

**The typefaces travel with the bundle.** Geist and Geist Mono come from
nixpkgs (`nix/env.nix`'s `ODU_GEIST_FONTS`) and are content-hashed beside the
stylesheet, never fetched from a font CDN — a tailnet-only or air-gapped board
must render the same page as a public one.

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
