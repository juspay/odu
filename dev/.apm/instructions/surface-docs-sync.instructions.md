---
description: When odu s user-facing surface changes (CLI commands/flags, MCP tools, the typed surface itself), keep the README and the ci/odu-mcp skills in sync in the same change
applyTo: "src/main.ts,src/cli/mcp.ts,packages/run-client/src/surface.ts,src/common/laneSurface.ts,src/mcp/**,src/coordinator/cancel.ts"
---

## Keep the surface docs in sync

odu's user-facing surface is documented in three places that drift silently if
a code change forgets them. When you add or change any of:

- a **CLI command or flag** (`src/main.ts`),
- an **MCP tool or its inputs** (`src/mcp/*Tool.ts`, registered in `src/cli/mcp.ts`),
- the **typed surface** procedures/cells/streams (`packages/run-client/src/surface.ts`
  for the fan-in a client dials, `src/common/laneSurface.ts` for the lane wire),

update **all three** in the *same* change:

1. **`README.md`** — the `## CLI` block, the MCP `| Tool |` table, and the agent-loop prose.
2. **`.apm/skills/odu/SKILL.md`** — the runner reference (modes, invocations, live commands).
3. **`.apm/skills/odu-mcp/SKILL.md`** — the agent-face tool list.

The skills are APM sources: edit them here, then `just apm` regenerates the
`.claude/` copies (never edit `.claude/skills/**` directly). Keep all three
concise — a one-line entry per command/tool, not a tutorial.
