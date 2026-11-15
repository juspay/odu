---
name: docs-writing
description: The writing standard for every page of odu's docs (website/src/content/docs). Shape limits the build enforces, the review rules beside them, the reference-entry template, and two worked before/after samples. Load before writing or editing any docs page.
---

# Writing odu's docs

Every page in `website/src/content/docs/` is held to this standard. Rules marked **[lint]** are enforced by `website/test/docs-lint.test.mjs`, which runs in `just website-check` and in `ci::website`. There is no exemption list and no per-page override. If a rule is wrong, change it here and in the lint, for every page.

## When you change a page

Edit the page so it stays true. Do not append a paragraph describing your change, and do not grow a table cell. History belongs in the commit log, not on the page. A new fact goes where a reader looks for it: a row in an existing table, an item in an existing list, or a sentence in the section that owns the topic.

## The reader

1. **One page, one reader, one job.** Every page is one of four kinds, and its `section` and place in the sidebar say which:
   - **Tutorial**: one path from nothing to a visible result.
   - **How-to**: the steps of one task, for a reader who knows what they want.
   - **Reference**: every fact about one surface, in a fixed order, for looking up.
   - **Explanation**: why something works the way it does, for a reader who asks.

   Content for a different reader moves to the page that owns it, and is linked.
2. **Write for someone using odu, not someone who built it.** Keep what the reader can see, do, or must know to predict what happens, including limits and failure messages. Cut history ("used to", "is gone"), why a design was chosen (unless the reader has to choose something), how it is implemented, and descriptions of looks the screen already shows. Cut roadmap too ("a later release", "until organisations land", "not yet"): say what is true now.
3. **Order by the reader's questions:** what is it → how do I start → how do I use it → what can go wrong → reference detail. The first screen answers the first two.

## Shape

4. **Opening paragraph ≤ 50 words:** what this is and what you do with it. No history.
5. **Paragraphs and list items ≤ 80 words. [lint]**
6. **Table cells ≤ 40 words. [lint]** A cell that needs more becomes an entry under its own heading.
7. **≤ 300 words of running text under one heading. [lint]** Tables and code do not count.
8. **A page ≤ 2,500 words of running text. [lint]** A page that cannot fit is split. No page is exempt.
9. **Three or more parallel things with attributes go in a table or a list**, never inside one sentence. A sequence the reader performs is an ordered list.
10. **No paragraph opens with a bold run-in. [lint]** Use a heading, a list or a table. A list item may open with a bold term, not a bold sentence.
11. **Headings say what the reader finds or does** ("Run the server's CI from your shell", "When a push fails"), in words the reader would search for. The test: someone who reads only the sidebar can say where each answer is.
12. **At most two cautions per page**, written as a blockquote, ≤ 50 words each, for cautions and limits only.

## Sentences and words

13. **No sentence over 40 words [lint]**; aim for an average under 20.
14. **At most one em-dash and one semicolon per sentence. [lint]** A pair of dashes around an aside counts as two: use parentheses or commas. The lint reads `--` as a dash too, since the site renders it as one.
15. **Second person, present tense, active voice.** "You run…", "odu pushes…".
16. **Bold is for words the reader sees on screen** (button, tab and field labels) and for a term at the point it is defined. Never for emphasis. No capitals for emphasis either. Quote a label exactly as the board renders it, and check it in the code (`packages/*/src/face*.tsx`, `packages/ci/src/face/`), not in an older page.
17. **Plain words first.** An internal name (a package, a protocol, a module) appears only if the reader types it or sees it, and is explained once in a short clause. Pick one word per thing and keep it. These are odu's:

| Say | Means | Do not say |
| --- | --- | --- |
| the board | odu's web page | "the page", "the face", "the UI" |
| run, node, recipe | one execution of the pipeline; one recipe on one platform in it; a `just` recipe | "job", "step" for a node |
| machine | a computer a run uses, listed in `hosts.json` | "venue" (it stays only in verb names) |
| lane | one platform's share of a run, on one machine. Define it at first use on a page. | — |
| the service | the `odu web` process | "the daemon" on user pages. It stays on operator pages. |
| bucket, store, pin | one cache; where a bucket keeps its objects; a name that holds a closure | — |
| root token, cache token, personal token, metrics token | Always the full name. | bare "token" where two kinds are in play |
| API verb | a name such as `run_start`, typed after `odu surface` or called over MCP | "tool", "procedure" |
| part of the service (`ci`, `cache`, `auth`, `cloudflare`, `metrics`) | what `odu surface <row> <verb>` calls a row. Use "row" only on `cli` and `contract-versions`, glossed once on each. | "row" anywhere else |
| sign-in, server mode | what `ODU_GITHUB_*` turns on | "a door", "a server with a door" |
| is shown, lists, returns, says | what a screen, a list or a verb does | "is drawn", "answers" for a field, "warmed", "narration" |

18. **No history words:** `used to`, `until now`, `previously`, `formerly`, `is gone`, `that is a fix`, `no longer`, `any more`, `as before`, `as it always has`, `retired`, `since X landed`. A renamed command or verb a reader may still have in a script goes in a table of old and new names, not in a sentence.
19. **Frontmatter `description` is one sentence, ≤ 160 characters. [lint]** It becomes the search snippet and the share card.

## Facts

20. **One fact, one home.** Another page that needs it gets at most two sentences and a link.
21. **Nothing is invented.** Every sentence traces to the code or to what the page said before. Where the old text is unclear, read the code. If code and page disagree, the code wins. The second sources are the CLI's own usage text, `packages/*/src/surface.ts`, and the blocks `packages/cache/src/useCopy.test.ts` binds. Those blocks are copied, never retyped.

## House style

Small choices a reader notices when they change from page to page. Every page makes them the same way.

22. **Spelling is British, with -ize (Oxford):** colour, behaviour, honour, centre, cancelled, labelled; organization, authorize, finalize, recognize. Identifiers, code, commands, product names, quoted messages and on-screen labels stay exactly as written, and so does Nix's own term *realise* (`nix-store --realise`). A label GitHub or Cloudflare shows stays as shown.
23. **One verb per pointer.** You press a key, click a control (a button, a tab, a row, a link) and tap only where the text is about a touch screen. A control you can click is "clickable", never "pressable".
24. **One way to write a shortcut:** one `<kbd>` per key, modifiers as words, joined by ` + `. odu's only chord is <kbd>Ctrl</kbd> + <kbd>C</kbd>. No bare "Ctrl-C" in text.
25. **odu is lower case**, also at the start of a sentence or a heading. A name the screen shows with a capital (an on-screen label) is quoted as it appears.
26. **One cast for examples:** the server `odu.example.com`, a bucket's own domain `cache.example.com`, the bucket `main`, the login `alice`, the revision `<rev>`. odu's own cache (`cache.kolu.dev/kolu-r2`) appears only where the reader has to trust it. Loopback examples stay `http://127.0.0.1:18440`.
27. **Commands use the `odu` shorthand.** A page whose examples use it says so once, in one sentence linking to [`/docs/#quick-start`](/docs/#quick-start), where the shorthand is defined. The consumer's guide (`your-repository`) keeps the pinned `nix run github:juspay/odu/<rev> --` form.

## Variants by kind

The lint thresholds apply to every page as they are. The other differences are review rules.

| Rule | Tutorial and how-to | Explanation | Reference |
| --- | --- | --- | --- |
| 5, 6, 7, 8, 10, 13, 14, 19 [lint] | as written | as written | as written |
| 2: cut rationale and implementation | cut. Link to the explanation page. | Keeps the "why". | No fact is cut. Argument for a design moves to the explanation page, and the entry links to it. |
| 3: order | tutorial: one path to a visible result. How-to: the task's steps. | the decision and its cost | one entry per command, verb group, metric group or route group |

A reference fact is a command, a flag, an API verb, an input field, an environment variable, a metric, a label, a log line, a route, an exit code or a version.

### The reference entry

Rule 7 gives a reference page its shape: one `###` entry per command, verb group, metric group or route group. Each `##` group opens with an index table whose first column links to the entries, because the sidebar lists only `##` headings. The index table's columns are the page's own (for the CLI: command · API verb · on the board · one line). Every entry uses the same order, omitting parts that do not apply:

1. Heading: the command or group, in code font.
2. One sentence: what it is.
3. Usage block.
4. Flags or fields: a table, one line each.
5. Behaviour: a list of facts.
6. Exits or refusals.
7. "Why" as a link to the explanation page.

## Sample: a guide passage

**Before** (`docs.md`, under "Self-host on NixOS", one paragraph, 145 words):

> **The push is its own step.** On a run's page each node that pushes grows a second segment under its bar — `pushed → <bucket> · N pushed · M present · X MiB · T`, the paths this node sent told apart from the ones the bucket already had (the `present` clause is omitted when there were none) — starting where the recipe's bar ends, amber while the closure is going up and red if it does not land. The node's own duration stays the RECIPE's. The push's `[odu] …` lines are a log of their own, not appended to the recipe's: the page offers **Recipe** and **Push** tabs, and `log_read` takes `stream: "recipe" | "push"` (absent is the recipe, so every existing caller reads what it always read) against the same log key. A push that fails makes the node RED, because green means warmed.

**After** (`daily-workflow`, about 45 words and a table):

> ## When a push fails
>
> A recipe's push is a separate step on the run's page, with its own log. A failed push turns the node red even when the recipe passed, so a green node means its outputs are in the cache. The node's duration counts the recipe only.
>
> | To read | On the board | CLI | API verb |
> | --- | --- | --- | --- |
> | the recipe's output | the **Recipe** tab | `odu ci logs KEY` | `log_read` |
> | the push's output | the **Push** tab | `odu ci logs KEY --stream push` | `log_read` with `stream: "push"` |

What changed: the bold run-in became a heading. The bar's colours and segments, which the screen shows, are gone. The capitals are gone. Three ways to read one log became a table. The passage moved from the operator's page to the page of the reader who meets a failed push.

A smaller case, showing rule 2. Before (`cache.md`): "Every byte used to cross the odu machine's uplink. It no longer has to: the store holds the whole protocol, so a reader can be sent to the store." After: "The store holds the whole protocol, so odu can send a reader to the store."

## Sample: a reference entry

**Before** (`docs.md`, CLI reference, one table cell, 158 words):

> | `cache push <bucket> <path>…`, `cache push --cache <substituter> <path>…`, `cache push <path>…` | Upload only what the bucket is missing; talks to the cache directly. `--cache` reads the push origin and the bucket off that cache's own `nix-cache-info`; with NEITHER a `--cache` nor a bucket, the substituter is read from `./flake.nix`'s `nixConfig`, probed ANONYMOUSLY, and pushed to with only a credential SAVED for that origin (`odu cache login`) — a repository named that URL, so the origin-agnostic `--token-file` and `$ODU_CACHE_TOKEN` stay out of scope for it, and a caller that wants its token sent names the target instead: `odu cache target` prints that URL, and `push --cache <that>` is a named one; a private bucket must be named with `--cache` (two odu caches there is a refusal). `--pin NAME` re-points that pin at the closure it landed. `--run ID` and `--commit SHA` state what built the paths, kept on every row this push stores and drawn on the bucket page; a push that states neither leaves what a run already stated alone | — (a build box's job) |

**After**: one row in the index table, and an entry.

> | [`odu cache push`](#odu-cache-push) | — | — | Uploads the paths a bucket is missing. |
>
> ### `odu cache push`
>
> Uploads only the paths the bucket is missing. It talks to the cache directly, so it runs on the machine that holds the paths.
>
> ```
> odu cache push <bucket> <path>…
> odu cache push --cache <substituter> <path>…
> odu cache push <path>…
> ```
>
> | You name | It pushes to | Cache token it sends |
> | --- | --- | --- |
> | `<bucket>` | that bucket, on the origin you logged in to | `--token-file`, then `$ODU_CACHE_TOKEN`, then the saved credential |
> | `--cache <substituter>` | the origin and bucket that cache states in its `nix-cache-info` | the same |
> | nothing | the one odu substituter in `./flake.nix`'s `nixConfig`; two is refused | only a credential saved for that origin with `odu cache login` |
>
> - With nothing named, odu probes the substituter without a token, so a private bucket must be named with `--cache`.
> - To send your own cache token to the flake's cache, name it: `odu cache target` prints the URL to pass to `--cache`.
>
> | Flag | What it does |
> | --- | --- |
> | `--pin NAME` | Re-points that pin at the closure this push landed. |
> | `--run ID`, `--commit SHA` | State what built the paths. The bucket keeps both on every path this push stores, and its page shows them. A push that states neither leaves what a run stated. |

Every fact and every code span of the old cell is still there, and the reason the token is withheld has its home in `cache/push`.

## Before you commit a page

- `cd website && node --test --test-name-pattern='<slug>' test/docs-lint.test.mjs`: the lint for that page. The pattern is a regular expression, so `'^index$'` runs the start page alone and `'^cache/index$'` the cache start page.
- `just website-linkcheck`: every internal link and `#anchor` in the built site resolves.
- Renamed a heading? Grep `website/src`, `README.md`, `packages/`, `skills/` and `.github/` for the old anchor and update every link in the same change. These titles are named from outside the site and stay verbatim: **Use odu from your repository**, **Server mode**, **Push from GitHub Actions**, and the heading **Set up an R2 bucket** on `cache/s3`.
- These anchors are linked from outside the site and must keep resolving on their old URL, as a heading or as a `<span id>` on a row of the page map:
  - `/docs/`: `quick-start`, `use-odu-from-your-repository`, `every-run-at-once-the-web-service`, `access-through-tailscale-or-a-proxy`, `self-host-on-nixos`, `metrics`, `contract-versions`, `server-mode`, `daily-workflow`, `coding-agents`, `coding-agents-mcp`, `cli-reference`, `troubleshooting`.
  - `/docs/cache/`: `create-a-bucket`, `use-it`, `private-buckets`, `tokens`, `push`, `push-from-github-actions`, `keep-and-reclaim`, `keep-a-bucket-on-s3`, `reads-leave-odu`, `where-the-data-lives`, `a-domain-for-a-bucket`, `the-cache-view`, `operating-it`, `protocol`, `command-reference`.
