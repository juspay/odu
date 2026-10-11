# @odu/cloudflare-lane

The far side of a Cloudflare Containers lane (experimental). Nothing in odu
imports it: `odu cloudflare setup` points the pinned wrangler at
`src/worker.ts` and deploys it to the operator's own account as `odu-lane`.

```
coordinator ──WS──▶ Worker ──▶ Durable Object (one per instance) ──▶ container :8080
                                                                     bridge.ts ──stdio──▶ odu-runner --stdio
```

| file | runs where | what it is |
| --- | --- | --- |
| `src/worker.ts` | Cloudflare | routes `/lane/<instance>/{start,agent,import,destroy}` to one container per instance; serves the R2 bucket as a Nix binary cache at `/nix-cache` |
| `src/entrypoint.sh` | container | the three Firecracker fixes (`/dev/shm`, `/dev/kvm`, nix.conf), then execs the bridge with odu's pinned bun |
| `src/bridge.ts` | container | one WebSocket = one `odu-runner --stdio`, the part sshd plays on an ssh lane; `/import` receives a NAR stream when there is no lane cache |

The coordinator half is `packages/execution/src/coordinator/cloudflare/`.
The image is the stock `docker.io/nixos/nix`; `bridge.ts` and `entrypoint.sh`
travel as text inside the Worker, so there is no Dockerfile and no registry push.
