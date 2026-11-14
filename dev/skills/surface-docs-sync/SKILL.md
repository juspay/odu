---
name: surface-docs-sync
description: Keep odu's surface docs (the docs page that owns the fact, website/src/content/docs/cli.md or website/src/content/docs/cache/reference.md, and the odu skill) in sync with the service contract. Use whenever editing src/main.ts, packages/cli/src/ciCli.ts, packages/cache/src/cli.ts, packages/auth/src/cli.ts, packages/service-client/src/surface.ts, packages/service-client/src/verbs.ts, packages/run-client/src/surface.ts, packages/execution/src/common/laneSurface.ts, packages/cli/src/serviceCli.ts, packages/cli/src/serviceMcp.ts, or anything that adds, renames or changes a verb, cell, CLI command or flag.
---

## Keep the surface docs in sync

odu has ONE public vocabulary — the shared service contract — and three faces
that project it: the browser, `odu surface` in a terminal, and `odu mcp` for an
agent. None of them may grow a verb of its own, so a surface change is always a
docs change too, in three places that drift silently otherwise.

When you add or change any of:

- the **service contract** — procedures, cells, collections or streams on
  `packages/service-client/src/surface.ts`, or what
  `packages/service-client/src/verbs.ts` exposes and under what name (that map
  is what the CLI and the MCP face are both derived from, so a rename there is a
  rename everywhere at once);
- a **CLI command or flag** — the root's words (`src/main.ts`), the runs' row's
  verbs (`packages/cli/src/ciCli.ts`), or a row's own shell-native door
  (`packages/cache/src/cli.ts`, `packages/auth/src/cli.ts`). A verb that would
  only exist in the CLI is a defect: administration is the board and
  `odu surface <row> <verb>` (PLAN 2.10);
- the **coordinator's own surface** — `packages/run-client/src/surface.ts` for
  the fan-in the daemon dials, `packages/execution/src/common/laneSurface.ts`
  for the lane wire;

update **all three** in the *same* change:

1. **The page that owns the fact**, under `website/src/content/docs/` — the
   page whose reader meets it (a run flag on `daily-workflow` or
   `remote-runs`, a push flag on `cache/push`, an agent verb on `agents`).
2. **The reference** — `website/src/content/docs/cli.md` for a run, auth or
   tunnel command or verb, `website/src/content/docs/cache/reference.md` for a
   cache verb or an `odu cache` command or flag, and
   `website/src/content/docs/contract-versions.md` for the version bump.
3. **`skills/odu/SKILL.md`** — the single authored skill: the
   bootstrap, the loop, and the CLI/MCP guidance, which are one skill because
   CLI and MCP are two faces of one service rather than two adoption paths.

Edit the page so it stays true. Do not append a paragraph or grow a table cell.
Every docs page is held to the `/docs-writing` standard
(`dev/skills/docs-writing/SKILL.md`), and `ci::website` fails a page that
breaks its shape limits.

`README.md` holds only the quick-start command and links into the docs. Touch
it only when that command or a heading it links to changes.
