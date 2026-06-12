---
description: When odu's user-facing surface changes (CLI commands/flags, MCP tools, the oRPC surface), keep the README and the ci/odu-mcp skills in sync in the same change
applyTo: "src/cli/main.ts,src/cli/mcp.ts,src/common/surface.ts,src/mcp/**,src/coordinator/cancel.ts"
---

## Keep the surface docs in sync

odu's user-facing surface is documented in three places that drift silently if
a code change forgets them. When you add or change any of:

- a **CLI command or flag** (`src/cli/main.ts`),
- an **MCP tool or its inputs** (`src/mcp/*Tool.ts`, registered in `src/cli/mcp.ts`),
- the **oRPC surface** procedures/cells/streams (`src/common/surface.ts`),

update **all three** in the *same* change:

1. **`README.md`** — the `## CLI` block, the MCP `| Tool |` table, and the agent-loop prose.
2. **`.apm/skills/ci/SKILL.md`** — the runner reference (modes, invocations, live commands).
3. **`.apm/skills/odu-mcp/SKILL.md`** — the agent-face tool list.

The skills are APM sources: edit them here, then `just apm` regenerates the
`.claude/` copies (never edit `.claude/skills/**` directly). Keep all three
concise — a one-line entry per command/tool, not a tutorial.
