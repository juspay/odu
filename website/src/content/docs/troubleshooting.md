---
title: Troubleshooting
description: What to do when odu refuses a run, a retry, a proxy or a client, or when GitHub is still waiting.
section: Use odu
order: 6
---

Find the symptom, then the next step. Each next step links to the page that explains it.

| Symptom | Next step |
| --- | --- |
| No hosts configured | Add a hosts file, or allow this machine with `--host SYSTEM=localhost`. See [Name the machines](/docs/machines/#name-the-machines). |
| Dirty checkout refused | Commit your changes, or run a snapshot of the working tree with `--no-strict`. See [Run uncommitted changes](/docs/daily-workflow/#run-uncommitted-changes). |
| Web service already running | Open its URL, or replace it with `odu web --upgrade`. |
| A proxied page is refused as cross-origin | Start or replace the service with `ODU_WEB_ALLOWED_ORIGINS` set to the browser's origin. See [Access through Tailscale or a proxy](/docs/web-service/#access-through-tailscale-or-a-proxy). |
| `serves the <row> row at …`: the service and your build disagree | That part of the service moved a major version. Run `odu web --upgrade`, or use a build that reads that version. See [Contract versions](/docs/contract-versions/). |
| Retry refused | Read the reason. Check the snapshot, the record of where the run ran, and whether the checkout is still there. |
| CI passed but GitHub is waiting | Check what the run still owes GitHub (`odu ci status`), and the service's `gh` credentials. |
| A node is red but its recipe passed | Its push failed. See [When a push fails](/docs/daily-workflow/#when-a-push-fails). |
