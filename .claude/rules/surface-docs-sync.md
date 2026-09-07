---
paths:
  - "src/main.ts"
  - "packages/service-client/src/surface.ts"
  - "packages/service-client/src/verbs.ts"
  - "packages/run-client/src/surface.ts"
  - "packages/execution/src/common/laneSurface.ts"
  - "packages/cli/src/serviceCli.ts"
  - "packages/cli/src/serviceMcp.ts"
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
- a **CLI command or flag** (`src/main.ts`);
- the **coordinator's own surface** — `packages/run-client/src/surface.ts` for
  the fan-in the daemon dials, `packages/execution/src/common/laneSurface.ts`
  for the lane wire;

update **all three** in the *same* change:

1. **`README.md`** — the `## CLI` block, the verb table, and the agent-loop prose.
2. **`website/src/content/docs.md`** — the reference the site publishes.
3. **`.apm/skills/odu/SKILL.md`** — the single authored skill: the bootstrap, the
   loop, and the CLI/MCP guidance, which are one skill because CLI and MCP are
   two faces of one service rather than two adoption paths.

The skill is an APM source: edit it here, then `just apm` regenerates the
`.claude/` copy (never edit `.claude/skills/**` directly). Keep all three
concise — a one-line entry per verb or command, not a tutorial.
