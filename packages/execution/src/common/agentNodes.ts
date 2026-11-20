import { Schema, type Stream } from "effect";
import {
  EMPTY_STATE,
  OwedStatusSchema,
  type PipelineState,
  postingOf,
} from "@odu/run-client/surface";
import { rowsOf } from "./verdict";

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
  /** The live run's identity: `sha7` the 7-char commit, `seq` its ordinal
   *  among runs of that commit (`<sha7>#<seq>`). Both are the no-run value
   *  (`""` / `null`) when `run` is false. */
  sha7: Schema.String,
  seq: Schema.NullOr(Schema.Int),
  nodes: Schema.Array(NodeRowSchema),
  /** Full owed GitHub status rows not yet confirmed. Empty when posting is
   *  healthy or disabled. */
  unposted: Schema.Array(OwedStatusSchema),
});
export type AgentNodes = typeof AgentNodesSchema.Type;

export interface AgentNodesReader {
  surface: {
    nodes: {
      get: (input: void) => Stream.Stream<AgentNodes, unknown>;
    };
  };
}

export const EMPTY_NODES: AgentNodes = {
  run: false,
  pipeline: null,
  sha7: "",
  seq: null,
  nodes: [],
  unposted: [],
};

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

export type ResolveRunContext = () => { repoRoot: string; sha7: string } | null;
