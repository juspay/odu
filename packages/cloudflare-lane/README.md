# @odu/cloudflare-lane

The far side of a Cloudflare Containers lane. Nothing in odu imports it.
`odu cloudflare setup` points the pinned wrangler at it and deploys two
Workers to the operator's own account. The coordinator half is in
`packages/execution/src/coordinator/cloudflare/`. The user-facing guide is the
"Run lanes on Cloudflare Containers" section of the website docs.

```
coordinator ──WS──▶ odu-lane (control plane) ──▶ odu-lane-dp: Durable Object <instance>-<dp version> ──▶ container :8080
                     │  auth, R2 cache, secrets,          (data plane: containers only)                 tini ▸ bridge.ts ──stdio──▶ odu-runner --stdio
                     │  start env per request
                     └── /nix-cache/* ◀──▶ R2 bucket odu-lane-cache
```

| file | runs where | what it is |
| --- | --- | --- |
| `src/worker.ts` | Cloudflare (`odu-lane`) | The control plane. It authenticates requests, serves the R2 bucket as a Nix binary cache, and routes `/lane/<instance>/{start,state,agent,import,destroy}` to the data plane, attaching the container's start env. It holds every secret and setting. |
| `src/dataPlane.ts` | Cloudflare (`odu-lane-dp`) | The data plane: the Durable Object that owns one container per instance. It holds no secrets and no configuration, and it is not publicly routable. |
| `src/http.ts` | Cloudflare | The runtime-free handlers (auth, cache, purge). `http.test.ts` drives them with the real Nix client. |
| `src/entrypoint.sh` | container | Applies the `/dev/shm`, KVM (or refuse), nix.conf and `pid_max` fixes, writes secrets to root-only files, adds the base tools, then starts tini and the bridge with odu's pinned bun. |
| `src/bridge.ts` | container | One WebSocket is one `odu-runner --stdio` in its own session, which is the part sshd plays on an ssh lane. It also handles `/import` (the NAR stream used when there is no cache) and runs the disk watchdog. |

## Design, and what it rests on

Each point below was measured on a live account.

- **Two scripts.** Any new version of a Worker script evicts its Durable
  Objects, and every attached lane's WebSocket runs through one of them.
  Measured twice: the socket drops about 5 minutes after a deploy (close code
  1006), and a `secret put` counts as a deploy. So everything that changes
  with configuration lives in the control plane, which hands the start env to
  the data plane per request. A 15-minute run rode through three
  control-plane changes with zero drops. The data plane changes only with
  container code, and setup will not deploy it under a running host without
  `--force`.
- **One venue per platform per run.** A DAG's nodes share one workspace
  (`install` → `unit`). Work spreads through `odu:shard`, where each shard gets
  its own container and its own dependency closure.
- **One recipe per vCPU.** The bridge starts each runner with
  `ODU_RUNNER_MAX_PARALLEL` = 4. A whole 20-node DAG started at once on 4 vCPU
  timed out on CPU.
- **tini as PID 1, and a session per dial.** With the bridge as PID 1,
  orphans were never reaped (zombies kept answering `kill(pid, 0)`). Every
  runner also shared process group 1, so one group kill reached all of them.
- **`pid_max` 4194304.** Without systemd the kernel keeps 32768, which CI test
  suites wrap within minutes.
- **Few, large messages.** `@cloudflare/containers` relays a WebSocket message
  by message through the Durable Object's JS thread. One message per stdout
  chunk delayed the RPC pings until the lane died, so both ends coalesce
  (64 KiB / 5 ms), and the bridge runs at nice -5, above its runners.
- **KVM or no lane.** `/dev/kvm` arrives 0600 root. The entrypoint opens it
  up for Nix's build users and refuses to run without it, so there is no
  silent fallback to software emulation.
- **Disk.** `/`, `/tmp` and Nix's build directories share one 18 GB ext4
  filesystem with about 2.76 M inodes. With four nodes writing at once, kolu
  filled it during a run that had started with 16 GiB free. The bridge
  collects the store whenever bytes or inodes fall under 25% free.
- **16,000-byte env vars.** Cloudflare caps each container env var at 16,000
  bytes, and `bridge.ts` exceeds that as plain text. It ships gzip'd and
  base64'd (about 5 kB), and `http.test.ts` pins that size.
- **Cold start.** A fresh instance starts in 3 s from the pre-warmed pool, or
  about 65 s on an account's first-ever pull of the image. The runner
  substitutes from the R2 cache in 7.6–12.6 s.
- **Concurrency.** This account ran at most 7 containers of one application
  at a time, a cap Cloudflare does not document. A support ticket raises it.
