/**
 * odu — a CI runner you attach to. ஓடு: run.
 *
 *   odu run [recipe[@platform]…] [flags]   run the [metadata("ci")] DAG
 *   odu status [-o json]                   snapshot a live run ({nodes, posting})
 *   odu logs [-f] <node>                   one node's log (replay + follow)
 *   odu attach [-o json]                   live dashboard / transition stream
 *   odu cancel [node|@platform]            stop the live run, or one node/lane
 *   odu runs [-o json]                     the durable run history (no live run)
 *   odu hosts                              venue inventory (free / busy / held by)
 *   odu lease [PLAT…] [--no-wait]          agent-held venue lease (cross-run)
 *   odu release [PLAT…]                    drop agent-held lease(s)
 *   odu dump                               resolved pipeline as JSON
 *   odu graph                              dependency graph (Mermaid)
 *   odu protect [--dry-run] [--branch B]   sync required status checks
 *   odu mcp                                serve the agent face (MCP, stdio)
 *
 * Strict by default: refuses a dirty tree, pins HEAD via `git worktree`,
 * posts commit statuses under `<recipe>@<platform>` contexts, splits logs
 * into `.ci/<sha>/<platform>/<recipe>.log`. Opt-outs: `--no-post` (strict,
 * no GitHub writes), `--no-snapshot` (live tree, implies --no-post),
 * `--no-strict` (≡ both — the dev-iteration one-flag opt-out).
 */

import { parseArgs } from "node:util";
import { runCommand } from "../coordinator/run";
import { loadJustPipeline, mermaidGraph } from "../just/ingest";
import {
  attachCommand,
  cancelCommand,
  logsCommand,
  statusCommand,
} from "./introspect";
import { hostsCommand } from "./hosts";
import {
  leaseCommand,
  leaseHoldCommand,
  releaseCommand,
} from "./leaseCmd";
import { mcpCommand } from "./mcp";
import { protectCommand } from "./protect";
import { runsCommand } from "./runs";

const USAGE = `usage: odu <run|status|logs|attach|cancel|runs|hosts|lease|release|dump|graph|protect|mcp> [args]

run [recipe[@platform]…] [--platform P]… [--host P=ADDR]… [--root NAMEPATH]
    [--no-deps] [--no-strict] [--no-snapshot] [--no-post] [--progress json]
    [--supersede] [--linger] [--no-wait]
status [-o json]              # json shape: { nodes, posting }
logs [-f] <node>
attach [-o json]
cancel [node|@platform]       # bare = whole run; node or @plat = partial
runs [-o json]
hosts
lease [PLAT…] [--no-wait]     hold a free venue across runs (agent layer)
release [PLAT…]               drop agent-held lease(s)
dump [--root NAMEPATH]
graph [--root NAMEPATH]
protect [--dry-run] [--branch B] [--platform P]…
mcp
`;

async function dispatch(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "run": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
          platform: { type: "string", multiple: true },
          host: { type: "string", multiple: true },
          root: { type: "string" },
          "no-deps": { type: "boolean" },
          "no-strict": { type: "boolean" },
          "no-snapshot": { type: "boolean" },
          "no-post": { type: "boolean" },
          progress: { type: "string" },
          supersede: { type: "boolean" },
          linger: { type: "boolean" },
          "no-wait": { type: "boolean" },
        },
      });
      if (values.progress !== undefined && values.progress !== "json") {
        throw new Error(`odu: unknown --progress format "${values.progress}"`);
      }
      return runCommand({
        selectors: positionals,
        platforms: values.platform ?? [],
        hostPins: values.host ?? [],
        root: values.root,
        noDeps: values["no-deps"] ?? false,
        noStrict: values["no-strict"] ?? false,
        noSnapshot: values["no-snapshot"] ?? false,
        noPost: values["no-post"] ?? false,
        progressJson: values.progress === "json",
        supersede: values.supersede ?? false,
        linger: values.linger ?? false,
        noWait: values["no-wait"] ?? false,
      });
    }
    case "status": {
      const { values } = parseArgs({
        args: rest,
        options: { output: { type: "string", short: "o" } },
      });
      return statusCommand(values.output === "json");
    }
    case "logs": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { follow: { type: "boolean", short: "f" } },
      });
      const node = positionals[0];
      if (node === undefined) throw new Error("odu: logs needs a node id");
      return logsCommand(node, values.follow ?? false);
    }
    case "attach": {
      const { values } = parseArgs({
        args: rest,
        options: { output: { type: "string", short: "o" } },
      });
      return attachCommand(values.output === "json");
    }
    case "cancel": {
      const target = rest[0];
      return cancelCommand(target);
    }
    case "runs": {
      const { values } = parseArgs({
        args: rest,
        options: { output: { type: "string", short: "o" } },
      });
      return runsCommand(values.output === "json");
    }
    case "hosts":
      return hostsCommand();
    case "lease": {
      const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { "no-wait": { type: "boolean" } },
      });
      const r = await leaseCommand({
        platforms: positionals,
        noWait: values["no-wait"] ?? false,
        nonBlocking: false,
      });
      return r.code;
    }
    case "release": {
      const { positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {},
      });
      return releaseCommand({ platforms: positionals });
    }
    case "lease-hold": {
      // Hidden: detached holder process. Not listed in usage.
      const { values } = parseArgs({
        args: rest,
        options: {
          platform: { type: "string" },
          repo: { type: "string" },
          "no-wait": { type: "boolean" },
        },
      });
      if (values.platform === undefined || values.platform === "") {
        throw new Error("odu lease-hold: --platform is required");
      }
      return leaseHoldCommand({
        platform: values.platform,
        noWait: values["no-wait"] ?? false,
        repoRoot: values.repo ?? process.cwd(),
      });
    }
    case "dump":
    case "graph": {
      const { values } = parseArgs({
        args: rest,
        options: { root: { type: "string" } },
      });
      const spec = loadJustPipeline(process.cwd(), { root: values.root });
      process.stdout.write(
        command === "dump"
          ? `${JSON.stringify(spec, null, 2)}\n`
          : mermaidGraph(spec),
      );
      return 0;
    }
    case "protect": {
      const { values } = parseArgs({
        args: rest,
        options: {
          "dry-run": { type: "boolean" },
          branch: { type: "string" },
          platform: { type: "string", multiple: true },
        },
      });
      return protectCommand({
        dryRun: values["dry-run"] ?? false,
        branch: values.branch,
        platforms: values.platform ?? [],
      });
    }
    case "mcp":
      return mcpCommand();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return command === undefined ? 1 : 0;
    default:
      process.stderr.write(`odu: unknown command "${command}"\n${USAGE}`);
      return 1;
  }
}

dispatch(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  },
);
