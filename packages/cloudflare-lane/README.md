# @odu/cloudflare-lane

The far side of a Cloudflare Containers lane. Nothing in odu imports it:
`odu cloudflare setup` points the pinned wrangler at `src/worker.ts` and
deploys it to the operator's own account as `odu-lane`. The coordinator half
is `packages/execution/src/coordinator/cloudflare/`; user-facing docs are the
"Run lanes on Cloudflare Containers" section of the website docs.

```
coordinator ──WS──▶ Worker ──▶ Durable Object <instance>-<codehash> ──▶ container :8080
                                                                     bridge.ts ──stdio──▶ odu-runner --stdio
```

| file | runs where | what it is |
| --- | --- | --- |
| `src/worker.ts` | Cloudflare | routes `/lane/<instance>/{start,state,agent,import,destroy}` to one container per instance; `/nix-cache/*` and `/nix-cache-purge` over the R2 binding |
| `src/http.ts` | Cloudflare | the runtime-free handlers (auth, the R2 bucket as a Nix binary cache, purge), unit-tested with the real Nix client in `http.test.ts` |
| `src/entrypoint.sh` | container | `/dev/shm`, `/dev/kvm`, nix.conf, secrets into root-only files, then the bridge with odu's pinned bun |
| `src/bridge.ts` | container | one WebSocket = one `odu-runner --stdio` (the part sshd plays on an ssh lane); `/import` receives a NAR stream when there is no lane cache |

The image is the stock `docker.io/nixos/nix`; `bridge.ts` and `entrypoint.sh`
travel as text inside the Worker, so there is no Dockerfile and no registry
push. The Durable Object name carries a hash of both, because a redeploy does
not restart a running container: new code always gets fresh containers.

Cloudflare behaviours this design rests on, each measured on a live account:

- A WebSocket proxied through the DO's `containerFetch` keeps the container
  awake; a 17-minute recipe with a 120 s silent stretch ran through.
- A new Worker version evicts the DOs, dropping attached WebSockets ~5 minutes
  after the deploy (1006). odu resurrects the lane; `setup` refuses to
  redeploy under a running declared host without `--force`.
- `api.github.com` from Cloudflare egress is rate-limited (403 on `github:` refs).
- Cold start of a fresh instance: 3 s from the pre-warmed pool, ~65 s on the
  account's first-ever pull of the image.
- The entrypoint is the container's PID 1. With the bridge there, orphans were
  never reaped (zombies kept answering `kill(pid, 0)`) and every runner shared
  process group 1, so one group kill reached them all. `tini` is init, and
  each dial's runner gets its own session.
- Without systemd, `pid_max` is the kernel's 32768, which CI-scale test
  suites wrap in minutes; the entrypoint raises it to a systemd host's 4194304.
- `@cloudflare/containers` relays a WebSocket message by message through the
  Durable Object's JS thread. One message per stdout chunk let seven
  recipes' logs delay the RPC pings until the lane died; the bridge and the
  connector coalesce, and the bridge runs at nice -5 above its runners.
- `/dev/kvm` arrives 0600 root: the entrypoint makes it usable by Nix's build
  users and refuses to run a lane without it (no silent TCG).
