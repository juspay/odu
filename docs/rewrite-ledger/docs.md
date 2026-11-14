# Ledger: `website/src/content/docs.md`

- Rewritten from: `21bb94d` (`website/src/content/docs.md`, 8,195 words of running text).
- Split into the pages below. `/docs/` is now the start page (`index`), and every old `##` anchor on it, plus `coding-agents-mcp`, is a `<span id>` on a row of its page map.
- This ledger is committed while the PR is open and deleted before merge.

## Headings

Every heading of the old page (`.waterfall/old-anchors-docs.txt`), and where its content went.

| Old heading | New home |
| --- | --- |
| Docs (h1) | `index`: the title is now "Start here", from frontmatter |
| Quick start | `index` "Quick start" (same anchor) |
| Use odu from your repository | `your-repository` (title verbatim); anchor is a map row on `/docs/` |
| 1. Declare the cache once | `your-repository` "1. Declare the cache once" |
| 2. Tag the pipeline | `your-repository` "2. Tag the pipeline", "Shard a leaf", "What a run pushes", "Keep your default branch's build" |
| 3. Run it | `your-repository` "3. Run it" |
| The machines it runs on (h4) | `machines` |
| Running the server's checkout (h4) | `remote-runs` "Start the run" |
| Run the server's CI from your shell (under Server mode) | `remote-runs` (title kept as the page's) |
| Daily workflow | `daily-workflow`; the anchor is a map row on `/docs/` |
| History and GitHub | `daily-workflow` "History", "GitHub statuses and required checks" |
| Working-tree snapshots (under Troubleshooting) | `daily-workflow` "Run uncommitted changes", "What a snapshot leaves out" |
| Coding agents (and the `coding-agents-mcp` span) | `agents`; both anchors are map rows on `/docs/` |
| CLI (under Coding agents) | `agents` "Use the CLI" |
| MCP (under Coding agents) | `agents` "Use MCP"; the cache verb rename table → `cache/reference` |
| 6. Agents (Use odu) | `your-repository` "6. Agents", which links to `agents` |
| Troubleshooting | `troubleshooting`; the anchor is a map row on `/docs/` |
| Every run at once: the web service | `web-service` "Start the service", "Use the board"; the anchor is a map row on `/docs/` |
| The board and the API do everything the CLI does | prose → `web-service` "Use the board"; the table → `cli` |
| Access through Tailscale or a proxy | `web-service` "Access through Tailscale or a proxy" (same heading); the old anchor is a map row on `/docs/` |
| Self-host on NixOS | `self-host`; the anchor is a map row on `/docs/`. Its run-push paragraphs → `your-repository`, "The push is its own step" → `daily-workflow`, "Disk does not grow forever" → `cache/retention` |
| Upgrading from a store-backed cache | `self-host` "Upgrade from a store-backed cache"; the `x-odu-upload` sentence → `cache/protocol` "Uploads" |
| Server mode | `server-mode` (title verbatim); the anchor is a map row on `/docs/` |
| Create the GitHub App | `server-mode` "Create the GitHub App" |
| Install it | `server-mode` "Install the App" |
| Configure odu | `server-mode` "Configure odu" |
| First sign-in and the first owner | `server-mode` "Sign in and make the first owner" |
| A token for a machine or an agent | `server-mode` "A token for a machine or an agent" (same heading) |
| Two instances | `server-mode` "Two servers" |

## index

- Kind: tutorial. Reader: someone trying odu.
- Written from: the intro and "Quick start".

### Moved

- `--no-strict` and `--no-snapshot` (what a working-tree run does) → `daily-workflow` "Run uncommitted changes" (linked).

### Cut

| Fact | Tag |
| --- | --- |
| "The same service also serves a Nix binary cache; see the binary cache docs" as a sentence | duplicate (now a link in the opening and a map row) |

## your-repository

- Kind: how-to. Reader: a developer adopting odu.
- Written from: "Use odu from your repository" §1–§9, without "The machines it runs on" and "Running the server's checkout"; the paragraphs "A run pushes to the cache its repository already reads from", "What a run pushes says where it came from, and may be held" and "Until organisations land" from "Self-host on NixOS".
- Fact homes: what a run pushes, and `odu:pin` in recipes.

### Moved

- The push action's inputs (`cache:` omitted, `token`, `pin`, `paths:`, the verification and step summary, `$GITHUB_SHA` as the commit) → `cache/github-actions`. Two sentences and a link stay in step 4.
- The first builder to state a path's run and commit keeps it → `cache/push` "Say what built a path".
- The `[linux]`/`[macos]` caution became a blockquote under the table.
- `run.start` reaching only a checkout the operator handed it → "Any checkout the service runs may push to any bucket it serves. The operator decides which checkouts the service runs."

### Cut

| Fact | Tag |
| --- | --- |
| "Until organisations land" | roadmap |
| "Your repository linked to the org that owns the bucket, so runs of it may push there" | roadmap. No such link exists: the code has no organization or repository-to-bucket record (`packages/cache/src`, `packages/service/src`). |
| "Your checkout handed to the server, until odu keeps its own clones" | roadmap; the present half is kept ("A checkout of your repository on the server") |
| "the bucket name is never written twice" | duplicate (the page says the cache is declared once) |
| "A recipe that builds but wants nothing pushed simply leaves no `result*` behind" | duplicate (the rule "a recipe that leaves no `result*` pushes nothing" says it) |
| "The odu skill that ships with it tells the agent how to use them" | duplicate (`agents`) |
| The DAG, "every path it warmed" | private word ("warmed"); now "the paths it pushed" |

### Changed because the code disagreed

| Old | New | Decided by |
| --- | --- | --- |
| "the bucket's page on the board (**Use this bucket**)" | the bucket's **Set up** block | `packages/cache/src/face.tsx` (panel title `Set up`; no "Use this bucket" label exists) |
| "the board's **Maintenance → Protect**" | **Maintenance** → **Apply protection** | `packages/ci/src/face/ops.tsx` (button `Apply protection`) |

## cli

- Kind: reference. Reader: anyone.
- Written from: "CLI reference", the table of "The board and the API do everything the CLI does", "Other shared verbs" (from "MCP"), and the exit codes.
- "row" is glossed once here, as the plan allows.

### Moved

- The prose of "The board and the API do everything the CLI does" (what an admin does from the Cache view, what an owner does on **People**, controls shown by role and refused by the service) → `web-service`.
- The `cache push` cell became the `### odu cache push` entry. Why the flake's cache gets only a saved credential → `cache/push`.
- The `ci run` cell became the `### odu ci run` entry, with one row per flag.

### Cut

| Fact | Tag |
| --- | --- |
| "Inspect and manage venue capacity" | private word ("venue"); now "Shows the machines and who holds them, and holds or releases one" |

### Added from the code

| Fact | Source |
| --- | --- |
| `--concurrency N` on `odu cache push` | `packages/cache/src/cli.ts` (`CACHE_USAGE`, `pushCommand` options) |
| `odu surface` exit 3 is "nothing is serving: run `odu web --background`" (the old page said "unreachable") | `packages/cli/src/serviceCli.ts` header comment |
| `metrics` verbs in the table of verbs without a command | `packages/host` metrics verbs, as listed on the old "Metrics" section |

## machines

- Kind: how-to. Reader: a developer setting up the machines a run uses.
- Written from: "The machines it runs on", and the hosts row of "Troubleshooting" (linked from `troubleshooting`).

### Moved

- `$ODU_HOSTS` with `--checkout` → `remote-runs` "Which machines it uses" (linked).

### Cut

| Fact | Tag |
| --- | --- |
| "which odu resolves from the build that shipped its own coordinator" | implementation; kept as "odu takes it from the same build as itself" |
| "lane host" | private word; now "machine" (a lane is defined on `your-repository`) |

### Changed for the word table

- "venue" is not used; `ci hosts` "shows the machines and who holds them".

## remote-runs

- Kind: how-to. Reader: a developer with a personal token.
- Written from: "Running the server's checkout" (Use odu §3) and "Run the server's CI from your shell" (Server mode).
- Fact home: `--checkout`, `--sha`, `--branch`.

### Moved

- Revoking a token, signing out and session expiry closing connections; sessions last 30 days; the cache protocol unchanged by sign-in → `server-mode` "Sessions and revoking".

### Cut

| Fact | Tag |
| --- | --- |
| "your cwd is a fact about your laptop, and the server's filesystem is not yours" | rationale |
| "a face does not decide that your fleet stops applying to your own run" | rationale |
| "saying 'mine is empty' about a world you are not in would blank the server's own variable, and on a pod whose Deployment sets the fleet that is the only inventory there is" | rationale |
| "it is the strict gate" | private word |
| "as it always has" | history |

## daily-workflow

- Kind: how-to. Reader: a developer running CI.
- Written from: "Daily workflow", "History and GitHub", "Working-tree snapshots", and "The push is its own step" from "Self-host on NixOS".
- Fact home: the push as its own step, its **Push** tab and `--stream push` ("When a push fails").

### Moved

- `ci wait`'s exit codes → `cli` "Exit codes" (linked).
- The `ci protect` contexts and `Maintenance` → `Apply protection` are also on `your-repository` step 5 (the setup reader); this page keeps the daily reader's two sentences.

### Cut

| Fact | Tag |
| --- | --- |
| The push segment's colours (amber, red) and where it starts on the bar | visible on screen |
| `pushed → <bucket> · N pushed · M present · X MiB · T`, verbatim | visible on screen; its parts are named in a sentence |
| "absent is the recipe, so every existing caller reads what it always read" | history |
| `stream: "recipe"` as a spelled value | duplicate (the default; `stream: "push"` is the one a reader types) |
| `ODU_SNAPSHOT_TRANSPORT=always`, `ODU_LANE_CONNECT_TIMEOUT_MS` | implementation (the old page: "a test seam, not a user mode") |
| "over the real lane stdio surface", "deterministic Git commit" | implementation |
| "posting debt" | private word; now "statuses odu still owes GitHub" (the `ci status` usage text says "what it still owes GitHub") |

## agents

- Kind: how-to. Reader: someone wiring an agent.
- Written from: "Coding agents", "CLI", "MCP" (without the cache verb table and "Other shared verbs").

### Moved

- "Other shared verbs" (`run_list` and the rest) → `cli` "API verbs without a command".
- The cache verb rename table, `no_root_token`, and `cache_gc_plan` being read-only → `cache/reference`.

### Cut

| Fact | Tag |
| --- | --- |
| "No separate `odu web` step is needed" | duplicate (the opening says both interfaces start the service) |
| "unified" (skill) | implementation |
| "Tool" as the table's column name, "tools" | word table: "API verb" (MCP tools kept once, where MCP is the subject) |
| "posting debt" | private word; now "statuses odu still owes GitHub" |
| "A sibling row's verbs mount under its key" | private word ("row"); now "typed after their part's name" |

### Added

- A link from "Use MCP" to `server-mode` for an agent's personal token, which "A token for a machine or an agent" already covers.

## troubleshooting

- Kind: how-to. Reader: anyone with a refusal.
- Written from: the symptom table of "Troubleshooting". Each row now links to the page that owns its fix.

### Added

- "A node is red but its recipe passed": from "The push is its own step" (a failed push turns the node red), for the reader who meets it here.

### Cut

| Fact | Tag |
| --- | --- |
| "placement evidence" | private word; now "the record of where the run ran" |
| "posting debt" | private word; now "what the run still owes GitHub" |
| "That row moved a major" | private word ("row"); now "That part of the service moved a major version" |

## web-service

- Kind: how-to. Reader: whoever starts `odu web`.
- Written from: "Every run at once: the web service", the prose of "The board and the API do everything the CLI does", and "Access through Tailscale or a proxy".

### Moved

- The CLI's shell-native commands → `cli` (its opening).
- The upstream switch on **Create bucket** → `cache/index` "Create a bucket".

### Cut

| Fact | Tag |
| --- | --- |
| "the cache row's operational `info` lines", "the host's own narration" | private words; now "the cache's operational lines" and "its other logging" |
| "drawn by the role … refused by the row" | private words; now "shows a control only to a role that may use it, and the service checks the role again" |
| "rather than greying the button out" | visible on screen |
| "In the loopback shape" | private word; now "Without sign-in" (a blockquote caution) |

### Changed because the code disagreed

| Old | New | Decided by |
| --- | --- | --- |
| "`odu web`'s page has **Runs** and **Cache** in the header" (cache.md) | the board's rail | `packages/web-ui/src/app.tsx` (`<aside class="sidebar">` with `Runs`, `Cache`, `Machines`, `Tunnel`, `People`) |
| **Maintenance** as a place in the board's navigation | **Maintenance** is a button on the run list | `packages/ci/src/face/board.tsx` |

## self-host

- Kind: how-to. Reader: an operator.
- Written from: what is left of "Self-host on NixOS" (the module, what it sets up, the first bucket, the S3 and domain pointers, `ODU_PUBLIC_ORIGIN`, "Without the module"), and "Upgrading from a store-backed cache".
- Fact home: environment variables for a host without the module, one table. `ODU_GITHUB_*` stays on `server-mode`.

### Moved

- The S3 store and the bucket domain: two sentences and a link each stay; the rest is on `cache/s3` and `cache/domain`.
- The tunnel carrying `ODU_PUBLIC_ORIGIN`'s host, and the App's callback moving with `publicOrigin` → `cache/domain` "The server's own address".
- Disk use ("disk is those objects plus staging…", the `upstreamKeys: []` disk cost) → `cache/operations` "How much disk and memory".
- `<state>/cache/objects` → `cache/operations` "Where the files are".
- What the migration does in the background → `cache/operations` "The one-time migration".

### Cut

| Fact | Tag |
| --- | --- |
| "What that does, in five sentences" | implementation (a list now) |
| "Those are the two shapes" | duplicate |
| "row-scoped background tasks" | implementation |
| Step 5 of the upgrade as a step | duplicate; it is the paragraph after the steps, since it is not something the reader does |

### Changed because the code disagreed

| Old | New | Decided by |
| --- | --- | --- |
| "the board and `/mcp`, which have no authentication in this release, stay off the public internet" | "Without server mode, the board and `/mcp` have no authentication, so the module keeps them off the public internet. With `services.odu.github` set, nginx serves them too, behind GitHub sign-in." | `nix/module.nix` (`serverMode = cfg.github.clientId != null`; the vhost's `locations` serve `/` and `/rpc/ws` in server mode, and only `/cache/`, `/_odu/v1/` and `/metrics` otherwise) |
| "a `--no-upstream` bucket" | a bucket created with `upstreamKeys: []` | `packages/cache/src/cli.ts` (no such flag; `push` parses only `token-file`, `concurrency`, `part-size`, `pin`, `run`, `commit`, `cache`, `origin`, `output`) and `packages/cache/src/face.tsx` (**Skip upstream paths** sends `upstreamKeys: []` when switched off) |

## server-mode

- Kind: how-to. Reader: an operator.
- Written from: "Server mode" without "Run the server's CI from your shell", plus the revoking and session paragraphs that ended that subsection.
- Fact home: roles (member, admin, owner), one table.

### Moved

- `ODU_GITHUB_*` stays here; every other environment variable → `self-host` "Without the module".

### Cut

| Fact | Tag |
| --- | --- |
| "later releases use its installation token to post checks and sync membership" | roadmap |
| "(no webhooks yet)" | roadmap |
| "odu does not store refresh tokens in this release" | roadmap ("in this release"); the present fact stays |
| "rather than holding a token that dies in eight hours" | rationale |
| "keep the downloaded `.pem` somewhere safe for later releases" | roadmap |
| "a daemon that silently stopped asking for sign-in would be a door that looks shut and is not" | rationale; now "so it never runs without sign-in when you meant it to have it" |
| "a loopback `odu web` behaves exactly as it did before" | history; now "lets every caller do everything" |
| "not a redirect and not an empty board" | visible on screen |
| "door", "principal" | private words |
| "the root token is spent" | duplicate (the next sentence says a second grant is refused) |

### Changed because the code disagreed, or by rule 26

| Old | New | Decided by |
| --- | --- | --- |
| "**The pod** (the project's own deployment)" with `ODU_PUBLIC_ORIGIN=https://odu-k3s.rooster-blues.ts.net` and `ODU_GITHUB_ALLOW=org:juspay` | "In a container", with `https://odu.example.com` and `org:example` | rule 26 (one cast for examples), as the plan directs for this block |
| "Your name at the foot of the rail opens the profile page" | "Click your login in the rail" | `packages/auth/src/face.tsx` (the account card's login button opens the profile) |
| "Create one" | **Create token** | `packages/auth/src/face.tsx` |
| "Half a configuration is refused at startup" | kept; the service's sentence is "sign-in is half configured — … Set all three, or none" | `packages/auth/src/github.ts` |
