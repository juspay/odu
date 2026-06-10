/**
 * `odu mcp` — the agent face. An MCP stdio server that re-exposes the live
 * surface as agent tools + subscribable resources, so a coding agent (Claude
 * Code, Codex, opencode, Gemini CLI) drives CI with structured calls instead
 * of scraping terminal output. In-band, like `status` / `logs` / `monitor`:
 * it dials `.ci/odu.sock` in the cwd and predetermines no host — which boxes
 * run the lanes stays the coordinator's job (pool lease / hosts.json).
 *
 * Built on the SDK's low-level `Server` (not `McpServer`) for two reasons:
 * full control over `resources/subscribe` + `notifications/resources/updated`
 * (McpServer doesn't manage per-resource subscriptions), and JSON-Schema tool
 * inputs validated by odu's own zod — no coupling to the SDK's schema layer.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SOCKET_PATH } from "../coordinator/socket";
import { NODES_URI, parseLogUri, ResourcePusher } from "./resources";
import {
  getNodes,
  killRuns,
  rerunNode,
  startRun,
  tailLog,
  waitForSettle,
} from "./tools";

function version(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(join(here, "../../package.json"), "utf-8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const TOOLS = [
  {
    name: "run",
    description:
      "Start a CI run the agent can then watch and drive. Spawns a background " +
      "`odu run` (its own coordinator) and returns once the run is live. Strict " +
      "by default (refuses a dirty tree); pass no_strict for a dev-iteration run " +
      "against the working tree. One run per checkout.",
    inputSchema: {
      type: "object",
      properties: {
        selectors: {
          type: "array",
          items: { type: "string" },
          description:
            "recipe[@platform] selectors; bare names fan out to every platform",
        },
        platforms: {
          type: "array",
          items: { type: "string" },
          description: "slice the fanout to these Nix system platforms",
        },
        hosts: {
          type: "array",
          items: { type: "string" },
          description: "PLATFORM=ADDR host pins (one per platform)",
        },
        root: { type: "string", description: "alternative DAG root namepath" },
        no_strict: {
          type: "boolean",
          description: "live tree, no GitHub posting (dev iteration)",
        },
        no_snapshot: { type: "boolean", description: "run the live tree" },
        no_post: { type: "boolean", description: "strict, but no GitHub writes" },
      },
    },
  },
  {
    name: "get_nodes",
    description:
      "Snapshot the live pipeline: every node's id, status, exit code and " +
      "duration in one structured frame. `run: false` when nothing is live.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tail_log",
    description:
      "One node's output so far (the buffered snapshot — replays a node that " +
      "already finished). Reads the live stream while a run is up, else the " +
      "durable per-SHA log file.",
    inputSchema: {
      type: "object",
      properties: {
        node: {
          type: "string",
          description:
            "node id (e.g. ci::e2e@x86_64-linux); a unique suffix works while live",
        },
      },
      required: ["node"],
    },
  },
  {
    name: "rerun_node",
    description:
      "Reset a node and its transitive dependents on the live DAG and " +
      "reschedule them — the only mutation, no new run process.",
    inputSchema: {
      type: "object",
      properties: {
        node: { type: "string", description: "node id to rerun" },
      },
      required: ["node"],
    },
  },
  {
    name: "wait_for_settle",
    description:
      "Block until the run settles, or — fail-fast (default) — the instant a " +
      "node goes red, so you can drill into a failure without waiting for the " +
      "slow lanes. Returns the verdict {settled, passed, failed[], errored[]}.",
    inputSchema: {
      type: "object",
      properties: {
        timeout_ms: { type: "number", description: "give up after this long" },
        fail_fast: {
          type: "boolean",
          description: "return on the first red node (default true)",
        },
      },
    },
  },
] as const;

const runInput = z.object({
  selectors: z.array(z.string()).optional(),
  platforms: z.array(z.string()).optional(),
  hosts: z.array(z.string()).optional(),
  root: z.string().optional(),
  no_strict: z.boolean().optional(),
  no_snapshot: z.boolean().optional(),
  no_post: z.boolean().optional(),
});
const nodeInput = z.object({ node: z.string() });
const waitInput = z.object({
  timeout_ms: z.number().optional(),
  fail_fast: z.boolean().optional(),
});

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}
function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `odu mcp: ${message}` }], isError: true };
}

/** Build the configured low-level server (no transport attached) — the unit
 *  the wiring tests construct directly. */
export function buildServer(socketPath: string = SOCKET_PATH): {
  server: Server;
  pusher: ResourcePusher;
} {
  const server = new Server(
    { name: "odu", version: version() },
    { capabilities: { tools: {}, resources: { subscribe: true } } },
  );

  const pusher = new ResourcePusher({
    socketPath,
    notify: (uri) => {
      void server.sendResourceUpdated({ uri });
    },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ ...t })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    const args = rawArgs ?? {};
    try {
      switch (name) {
        case "run":
          return ok(await startRun(runInput.parse(args), { socketPath }));
        case "get_nodes":
          return ok(await getNodes(socketPath));
        case "tail_log":
          return ok(await tailLog(nodeInput.parse(args).node, socketPath));
        case "rerun_node":
          return ok(await rerunNode(nodeInput.parse(args).node, socketPath));
        case "wait_for_settle": {
          const a = waitInput.parse(args);
          return ok(
            await waitForSettle({
              timeoutMs: a.timeout_ms,
              failFast: a.fail_fast,
              socketPath,
            }),
          );
        }
        default:
          return fail(`unknown tool "${name}"`);
      }
    } catch (e) {
      return fail((e as Error).message);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: NODES_URI,
        name: "pipeline nodes",
        description:
          "The live pipeline as JSON (snapshot). Subscribe for an updated " +
          "notification on every node transition.",
        mimeType: "application/json",
      },
    ],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: "odu://log/{node}",
        name: "node log",
        description:
          "One node's output. Subscribe for an updated notification as it " +
          "appends.",
        mimeType: "text/plain",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const { uri } = req.params;
    if (uri === NODES_URI) {
      const nodes = await getNodes(socketPath);
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(nodes, null, 2),
          },
        ],
      };
    }
    const node = parseLogUri(uri);
    if (node !== null) {
      const log = await tailLog(node, socketPath);
      return {
        contents: [{ uri, mimeType: "text/plain", text: log.text }],
      };
    }
    throw new Error(`odu mcp: unknown resource "${uri}"`);
  });

  server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    pusher.subscribe(req.params.uri);
    return {};
  });
  server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    pusher.unsubscribe(req.params.uri);
    return {};
  });

  return { server, pusher };
}

/** Serve over stdio until the client disconnects (stdin EOF). */
export async function runMcpServer(
  socketPath: string = SOCKET_PATH,
): Promise<void> {
  const { server, pusher } = buildServer(socketPath);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      pusher.stop();
      killRuns();
      resolve();
    };
    server.onclose = shutdown;
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
