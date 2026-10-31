# @odu/credentials

**This machine's token files.** One JSON object per store, keyed by ORIGIN, at
`~/.config/odu/<store>/credentials`, mode 0600 — the shape `gh` and `docker`
use, so a laptop can be pointed at the pod and at a local daemon at once.

Part of the odu repo — `"@odu/credentials": "workspace:*"`.

## One door

| door | what it is | browser-safe |
| --- | --- | --- |
| `.` | `credentialsPath`, `readCredentials`, `saveCredential`, `normalizeOrigin` — `store` is the one word a row supplies | ❌ |

## Why it is a package

Two rows keep a token per origin: the cache's bucket credentials
(`odu cache login`, `odu cache push`) and the auth row's personal tokens
(`odu auth login`). The second copy was correct by a comment — "the same shape"
— which is exactly how the two spellings of `.netrc` drifted before. Here the
layout, the 0600 mode and the per-origin rule are written once; a row names its
store and cannot get the rest wrong.

It reads the filesystem, so it is CLI-side only: no row imports it, and the
browser cannot. `@odu/cordis` is where a browser and a daemon share vocabulary,
which is why this is not there.
