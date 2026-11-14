---
title: Keep and reclaim
description: How long a bucket keeps a path, how pins hold a closure, why a path is still there, and how to collect garbage or delete a bucket.
section: Binary cache
order: 4
---

A bucket keeps what someone wants and lets the rest go. A path stays while retention holds it, a kept path refers to it, or a pin holds it. Garbage collection takes the rest, once a day on its own or when you ask.

Commands are written with the [`odu` shorthand](/docs/#quick-start).

```sh
odu surface cache pin_create --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","bucket":"main","name":"release-1.2","paths":["./result"]}' --json
odu surface cache gc_run --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","bucket":"main"}' --json
odu surface cache stats_read --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'"}' --json
```

## Retention

Retention counts from the last time somebody wanted a path, not from the last time it was read. A path's `lastWanted` is renewed by a stored push of it, and by the `missing` query a push asks first, whether the bucket had the path or not. A read moves the path's `hits` and nothing else. [How the cache works](/docs/cache/how-it-works/#why-a-read-does-not-renew-retention) says why.

A bucket keeps what nobody wants for 90 days unless you set otherwise.

| To set it | Where |
| --- | --- |
| at creation | `retentionDays` on `bucket_create` |
| afterwards | the bucket's **Retention** panel, or `bucket_retention` |

Zero means "keep only what a kept path refers to, or a pin holds".

## Pins

A pin is a name over a closure. A pinned closure is never collected.

- Pinning under a name that exists re-points it: the same name, today's closure, and yesterday's roots let go at once.
- Garbage collection follows the bucket's own references out from a pin's roots, so a path pushed later under a pinned root is held too.
- A push pins with `--pin NAME`, or `pin: true` in the push action. That is how a repository keeps its default branch's closure: see [Keep your default branch's build](/docs/your-repository/#keep-your-default-branchs-build).
- On the board, a bucket's **Pins** tab lists each pin's name, system, paths, when it was made and by whom, and pins a closure with **Pin closure**. Click a pin's name to see its roots.

## Why a path is still here

The bucket's **kept by** column says why each path is still here and when it goes. It is the collector's own answer, the same one `gc_run` acts on, and `cache_bucket_paths` returns it as `keptBy`.

| The column says | Why it is kept | When it goes |
| --- | --- | --- |
| `pin <name>` (`+N` for more pins) | a pin's closure reaches it | when the pin is deleted or re-pointed |
| `retention · in 83d` | its own last want is the latest clock holding it | when that clock runs out |
| `reference · in 83d` | a path that needs it, directly or not, was wanted later. Hover to see which. | when that path's clock runs out |
| `nothing · next collection` | no pin, and every clock has run out | the next daily collection, or **Run GC** |

- Hover a cell for the whole sentence and the day the path leaves.
- A package row shows its version held longest (any pinned one, else the latest) among those the filter leaves. Open the row to see each version.
- The column is a snapshot, like the rest of the list. **refresh paths** asks again, and changing **Retention** re-reads it.
- Pin names are part of the answer, so anyone who can read the path list sees them.

## Read the dry run before you collect

The dry run says exactly what the next collection would take: the count, the bytes it would free, and the paths wanted longest ago, first to go at the top. It changes nothing.

On the board it is **Dry run** beside **Run GC**. The API verb is `cache_gc_plan`.

The dry run can ask about a retention of your own. Type a number of days in the **retention** field beside the button, whose placeholder is the bucket's own, such as `bucket's (90d)`. The button then names your number, as in **Dry run at 0 days**, and the answer starts with "At N days' retention".

- `retentionDays` on `cache_gc_plan` is a whole number of days, zero or more. Absent means each bucket's own number.
- `0` asks what is here that nothing refers to and no pin holds.
- Anything else is refused `bad_input` with "retention must be a whole number of days, zero or more".
- Nothing is written. Only **Retention** changes what a bucket keeps, and `cache_gc_run` takes no `retentionDays`.

## Collect garbage

Collection runs once a day over every bucket, so a cache nobody administers still stops growing. `gc_run` and **Run GC** run the same collection now.

- A path is evicted only when its retention has run out, no kept path in the bucket refers to it, and no pin holds it.
- A collection of every bucket also sweeps orphans: objects in the store that no path names, such as an upload whose record never landed. It reports them beside what it evicted.
- It uses only the store's own list and delete, so a bucket on R2 collects exactly as one on disk.
- Every deleted object's URL is announced. A bucket behind a Cloudflare tunnel has them purged at the edge.

## When a collection stops

A collection deletes in batches of five hundred paths, one request per thousand objects where the store allows it. Each batch deletes its objects before it forgets its paths, so nothing is forgotten before its bytes are gone.

When the store refuses a delete, odu asks again five times, backing off. R2 returns `429` when asked too fast. If it still fails, the collection ends with `stopped`: one sentence, shown in red in the **Garbage collection** panel. What was evicted is on the report beside it, everything not deleted is still recorded, and **Run GC** carries on from there.

A push lands while a collection runs, without waiting for it.

## Delete a bucket

```sh
odu surface cache bucket_delete --input '{"rootToken":"'"$ODU_ROOT_TOKEN"'","bucket":"r2test"}' --json
```

On the board, it is the **Delete this bucket** panel under **Danger zone**, last on a bucket's page. Type the bucket's name into the field, and **Delete bucket** becomes clickable. Nothing else confirms it, and the board returns to the bucket list when it is done. There is no CLI command.

1. Everything under the bucket's prefix in its store is deleted: every NAR, every narinfo, `nix-cache-info`, and anything left over, such as an orphan. The verb returns `objects` and `bytes`: store objects removed, not paths.
2. Then the bucket goes, with its paths, its pins and the cache tokens whose bucket glob is exactly its name. A wider glob such as `team-*` is left alone.
3. Every deleted address is announced for purging at the edge.

There is no pin guard: a pin cannot outlive its bucket. Two cases are refused, with a sentence the board shows in place:

- A bucket with a domain. Clear the domain first (`bucket_domain` with no `domain`), so no DNS record points at nothing.
- A bucket being moved to another store. Let the move finish.
