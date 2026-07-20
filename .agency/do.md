# /do config

## Check command
`pnpm typecheck` — runs `tsc --noEmit` over the package.

## Test command
`pnpm test:unit` — runs the vitest suite (`vitest run`).

## Documentation
Keep `README.md` in sync with user-facing changes.

## PR evidence

odu is a terminal tool, so evidence is a **live terminal recording**, not a
screenshot: record the behavior with [`asciinema`](https://asciinema.org), render
it to a gif with [`agg`](https://github.com/asciinema/agg), host the gif on the
repo's `evidence-assets` GitHub release, and embed it in a `## Evidence` PR
comment. Post evidence whenever a change has observable runtime behavior (a new
command, a state transition, a fixed hang/leak) — the trigger is "is there
behavior worth showing?", not "does a pixel change?". Skip only for pure
internal refactors with no externally visible effect.

**Make it reproducible.** Drive the real, nix-built binary from a small script
committed under `tests/evidence/` (e.g. `tests/evidence/cancel-demo.sh`), against
a throwaway fixture pinned to a localhost lane (`ODU_HOSTS` → a hosts file
naming this machine's platform `localhost`; an empty `{}` is refused — see
juspay/odu#46), with `say`/`cmd` helpers narrating each step. The script *is*
the recipe —
re-run it to regenerate the gif when behavior changes.

```sh
odu=$(nix build .#odu --no-link --print-out-paths)/bin/odu

# 1) Record the script's PTY (headless = no interactive terminal needed). `-i 2`
#    caps idle gaps (e.g. waiting for a run to come up) to 2s in playback.
nix run nixpkgs#asciinema -- rec --headless --window-size 92x20 -i 2 --overwrite \
  -c "bash tests/evidence/<demo>.sh $odu $PWD" /tmp/demo.cast

# 2) Render to a gif. agg needs a monospace font on the box:
font=$(nix build nixpkgs#dejavu_fonts --no-link --print-out-paths)/share/fonts/truetype
nix run nixpkgs#asciinema-agg -- --speed 1.3 --theme asciinema --font-size 22 \
  --font-dir "$font" --font-family "DejaVu Sans Mono" /tmp/demo.cast /tmp/demo.gif

# 3) Host on the repo's evidence-assets release (create it once), then embed.
gh release create evidence-assets --title "Evidence assets" \
  --notes "Hosting for PR evidence gifs/recordings." 2>/dev/null || true
gh release upload evidence-assets /tmp/demo.gif --clobber
# → ![demo](https://github.com/juspay/odu/releases/download/evidence-assets/demo.gif)
```

A state that has no visual motion (e.g. a run lingering past settle looks like a
running run) rides along as a `console` transcript in the same comment. CI
(`tests/e2e/*.e2e.test.ts`, black-box against the nix-built binary on both
platforms) remains the correctness gate; the gif is the human-legible proof.
