/**
 * The AGENT'S VIEW of a run — the flattened rows an agent triages, and the
 * reader that serves them.
 *
 * A projection of `PipelineState`, and domain rather than transport: the same
 * shape answers the MCP `nodes` resource, the settle core's verdict, and (in
 * the next release) a service face that speaks no MCP at all. It lived beside
 * the MCP projection that first needed it, which made the settle wait — the
 * engine — import an agent face to say what a run's rows are. That is the one
 * edge that would have made `execution` and `cli` mutually dependent, so it is
 * the one edge that had to go.
 *
 * `@kolu/surface`'s projection machinery stays where it belongs, next door:
 * what is here is the vocabulary, not the wiring.
 */

import { Schema, type Stream } from "effect";
import {
  EMPTY_STATE,
  OwedStatusSchema,
  type PipelineState,
  postingOf,
} from "@odu/run-client/surface";
import { rowsOf } from "./verdict";

/** MCP-facing numerics are `Schema.Int`, not `Schema.Number` (kolu PLAN D8,
 *  divergence 2): `Schema.Number` is a codec tolerant of Infinity/NaN, and its
 *  JSON Schema is an `anyOf` that offers a host the literal string `"NaN"` as a
 *  valid value. These are an exit code and a millisecond duration — integers by
 *  construction — so the faithful spelling is also the one that advertises
 *  `{"type":"integer"}`. */
const NodeRowSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: Schema.String,
  exit_code: Schema.NullOr(Schema.Int),
  duration_ms: Schema.NullOr(Schema.Int),
  red: Schema.Boolean,
});

export const AgentNodesSchema = Schema.Struct({
  run: Schema.Boolean,
  pipeline: Schema.NullOr(Schema.String),
  /** The live run's identity, projected from `PipelineState` so an agent
   *  verdict says WHICH run it describes (juspay/odu#49): `sha7` the 7-char
   *  commit, `seq` its ordinal among runs of that commit (`<sha7>#<seq>`).
   *  Both are the no-run value (`""` / `null`) when `run` is false. */
  sha7: Schema.String,
  seq: Schema.NullOr(Schema.Int),
  nodes: Schema.Array(NodeRowSchema),
  /** Full owed GitHub status rows not yet confirmed (juspay/odu#61).
   *  Empty when posting is healthy or disabled; test verdict stays the truth. */
  unposted: Schema.Array(OwedStatusSchema),
});
export type AgentNodes = typeof AgentNodesSchema.Type;

/**
 * The B-side read slice: the projected agent client's `nodes` stream read
 * (snapshot-then-deltas over `AgentNodes`), spelled once here so the two ends of
 * the projection don't author divergent `{ surface: { nodes: { get } } }`
 * shapes. The input is `void` to match `agentSpec.streams.nodes.inputSchema`
 * (`z.void()`). Permissive (the concrete projected client assigns) so consumers
 * needn't re-materialize the precise client union. Distinct from
 * `OduSurfaceClient`, which is the A-side (`PipelineState`) slice — that
 * projection boundary justifies two shapes, one per side. */
export interface AgentNodesReader {
  surface: {
    nodes: {
      get: (input: void) => Stream.Stream<AgentNodes, unknown>;
    };
  };
}

/** The no-run frame: `run: false`, no pipeline, and the no-run identity
 *  (`sha7: ""`, `seq: null`). Exported so a consumer reading a run's identity
 *  from a missing/absent frame spells the no-run value once, here, rather than
 *  re-authoring the sentinel. */
export const EMPTY_NODES: AgentNodes = {
  run: false,
  pipeline: null,
  sha7: "",
  seq: null,
  nodes: [],
  unposted: [],
};

/** Project a coordinator `PipelineState` onto the agent `nodes` frame — the
 *  same mapping the live projection applies on every A→B delta. Shared so the
 *  CLI `odu wait` path can feed `waitForSettle` without re-deriving rows or
 *  drifting from the MCP face. An empty order is the no-run / pre-run value
 *  (`EMPTY_STATE` when no coordinator is live). */
export function toAgentNodes(state: PipelineState): AgentNodes {
  return state.order.length === 0
    ? EMPTY_NODES
    : {
        run: true,
        pipeline: state.name,
        sha7: state.sha7,
        seq: state.seq ?? null,
        nodes: rowsOf(state),
        unposted: [...postingOf(state).owed],
      };
}

/**
 * Where am I checked out and at what SHA — the durable-log identity, resolved
 * through an injection boundary rather than probed.
 *
 * A type, and it lives with the projection rather than with the MCP face that
 * first needed one, because the settle core takes the same seam: both answer
 * "which checkout am I speaking about" without either of them reaching for
 * git. Returns `null` outside a git checkout (or with an unreadable HEAD), in
 * which case a durable read reports "missing".
 */
export type ResolveRunContext = () => { repoRoot: string; sha7: string } | null;
