/**
 * WHAT EACH NIX LINE WROTE, recorded rather than computed.
 *
 * Each entry is a self-referencing derivation made content-addressed by one
 * Nix, on x86_64-linux: `nar` is `nix store dump-path` of the path
 * `nix store make-content-addressed` produced, and `ca` and `narHash` are what
 * that Nix's `path-info` said. `selfref` is `echo $out > $out` (one occurrence,
 * at NAR offset 107); `selfref3` is `echo $out $out $out > $out` (three).
 *
 * Nix 2.17 through 2.34 hash the zeroed bytes alone (`withoutOffsets`); Nix
 * 2.35 and later follow them with `|<offset>` per occurrence (`withOffsets`).
 */
export const NIX_RECORDED = {
  selfref234: {
    nix: "2.34.9",
    form: "withoutOffsets",
    storePath: "/nix/store/6gyc4k1ilcw1k97kf3dnzwia3rq6vakd-selfref",
    ca: "fixed:r:sha256:163ryiah9ms80qck6zb6dpy7sz9db61pjx460983wd3yyb41r7gl",
    narHash: "sha256-zw74FRmG9fFpyFWUQggmwd4mhYQgCbQCN5FrY42kFFo=",
    nar: "DQAAAAAAAABuaXgtYXJjaGl2ZS0xAAAAAQAAAAAAAAAoAAAAAAAAAAQAAAAAAAAAdHlwZQAAAAAHAAAAAAAAAHJlZ3VsYXIACAAAAAAAAABjb250ZW50czQAAAAAAAAAL25peC9zdG9yZS82Z3ljNGsxaWxjdzFrOTdrZjNkbnp3aWEzcnE2dmFrZC1zZWxmcmVmCgAAAAABAAAAAAAAACkAAAAAAAAA",
  },
  selfref235: {
    nix: "2.35.6",
    form: "withOffsets",
    storePath: "/nix/store/j9xpm5a9yzp9v5slnxsgvay2lnwqi2l6-selfref",
    ca: "fixed:r:sha256:14869lj9vs5fmpd0f1p5msrn1jdl7hd146xaimv4l6zivgmc71zl",
    narHash: "sha256-XUFNQ9+fHf+Zow3TLUYxj/5FPxAn9wKBcq+ia2Q3PRM=",
    nar: "DQAAAAAAAABuaXgtYXJjaGl2ZS0xAAAAAQAAAAAAAAAoAAAAAAAAAAQAAAAAAAAAdHlwZQAAAAAHAAAAAAAAAHJlZ3VsYXIACAAAAAAAAABjb250ZW50czQAAAAAAAAAL25peC9zdG9yZS9qOXhwbTVhOXl6cDl2NXNsbnhzZ3ZheTJsbndxaTJsNi1zZWxmcmVmCgAAAAABAAAAAAAAACkAAAAAAAAA",
  },
  selfref3_234: {
    nix: "2.34.9",
    form: "withoutOffsets",
    storePath: "/nix/store/a47j6cb8nb8k2zl4b7xiddhsvp9k28h4-selfref3",
    ca: "fixed:r:sha256:021cdpl2sqz8w99901sqd6lkmpmk1ffk77i2g8zyn1zdyv7kl9bh",
    narHash: "sha256-3ydRgiEt3QP5qS6zPPPuD6eQNbg1LlaJiEepmyhEu4U=",
    nar: "DQAAAAAAAABuaXgtYXJjaGl2ZS0xAAAAAQAAAAAAAAAoAAAAAAAAAAQAAAAAAAAAdHlwZQAAAAAHAAAAAAAAAHJlZ3VsYXIACAAAAAAAAABjb250ZW50c58AAAAAAAAAL25peC9zdG9yZS9hNDdqNmNiOG5iOGsyemw0Yjd4aWRkaHN2cDlrMjhoNC1zZWxmcmVmMyAvbml4L3N0b3JlL2E0N2o2Y2I4bmI4azJ6bDRiN3hpZGRoc3ZwOWsyOGg0LXNlbGZyZWYzIC9uaXgvc3RvcmUvYTQ3ajZjYjhuYjhrMnpsNGI3eGlkZGhzdnA5azI4aDQtc2VsZnJlZjMKAAEAAAAAAAAAKQAAAAAAAAA=",
  },
  selfref3_235: {
    nix: "2.35.6",
    form: "withOffsets",
    storePath: "/nix/store/sqgmachsw321zm4lk82jah8672n21kdw-selfref3",
    ca: "fixed:r:sha256:137bh2gvlyga38r1y1hvi82gix280pmv1mcw1672kd8sidw8wj5y",
    narHash: "sha256-U/B+4zM6wLbdzTWM/hCLPKE7QaOWJfIJPdMA4HQffuU=",
    nar: "DQAAAAAAAABuaXgtYXJjaGl2ZS0xAAAAAQAAAAAAAAAoAAAAAAAAAAQAAAAAAAAAdHlwZQAAAAAHAAAAAAAAAHJlZ3VsYXIACAAAAAAAAABjb250ZW50c58AAAAAAAAAL25peC9zdG9yZS9zcWdtYWNoc3czMjF6bTRsazgyamFoODY3Mm4yMWtkdy1zZWxmcmVmMyAvbml4L3N0b3JlL3NxZ21hY2hzdzMyMXptNGxrODJqYWg4NjcybjIxa2R3LXNlbGZyZWYzIC9uaXgvc3RvcmUvc3FnbWFjaHN3MzIxem00bGs4MmphaDg2NzJuMjFrZHctc2VsZnJlZjMKAAEAAAAAAAAAKQAAAAAAAAA=",
  },
} as const;
