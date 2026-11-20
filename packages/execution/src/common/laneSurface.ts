import { buildSurfaceFace } from "@kolu/surface/client";
import { defineSurface } from "@kolu/surface/define";
import type { SurfaceDispatch } from "@kolu/surface/link";
import type { SurfaceClientOf } from "@kolu/surface/project";
import { Schema } from "effect";
import { nodePrimitives, nodeProcedures } from "@odu/run-client/surface";
import { TaskSpecSchema } from "./spec";

/** `run.configure` input: either `workspace` (a checkout the runner can use
 *  as-is) or `origin` + `sha` (the runner fetches the pushed SHA). */
export const SnapshotRefSchema = Schema.Struct({
  commit: Schema.String,
  requires: Schema.Array(Schema.String),
  bundle: Schema.Boolean,
});
export const ConfigureInputSchema = Schema.Struct({
  snapshot: Schema.optionalKey(SnapshotRefSchema),
  name: Schema.String,
  origin: Schema.NullOr(Schema.String),
  sha: Schema.NullOr(Schema.String),
  workspace: Schema.NullOr(Schema.String),
  tasks: Schema.Array(TaskSpecSchema).check(Schema.isMinLength(1)),
});
export type ConfigureInput = typeof ConfigureInputSchema.Type;

export const ConfigureOutputSchema = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
});
export type ConfigureOutput = typeof ConfigureOutputSchema.Type;

export const ExtendInputSchema = Schema.Struct({
  tasks: Schema.Array(TaskSpecSchema).check(Schema.isMinLength(1)),
});
export type ExtendInput = typeof ExtendInputSchema.Type;

/** Who holds a venue lock (`holder|run|sinceMs` on the agent). */
export const LeaseHolderSchema = Schema.Struct({
  holder: Schema.String,
  run: Schema.NullOr(Schema.String),
  sinceMs: Schema.Number,
});
export type LeaseHolder = typeof LeaseHolderSchema.Type;

/** Default remote venue lock path; override via claim/probe input or
 *  `ODU_LEASE_LOCK` on the agent. */
export const DEFAULT_LEASE_LOCK = "/tmp/odu.lease";

const LeaseClaimInputSchema = Schema.Struct({
  holder: Schema.String.check(Schema.isMinLength(1)),
  run: Schema.NullOr(Schema.String),
  /** Absolute path on the agent host. Omit → agent default; spelling it
   *  `undefined` is a decode failure. */
  lockPath: Schema.optionalKey(Schema.String),
});

export const LeaseClaimOutputSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("held") }),
  Schema.Struct({
    status: Schema.Literal("busy"),
    heldBy: Schema.NullOr(LeaseHolderSchema),
  }),
  Schema.Struct({ status: Schema.Literal("error"), error: Schema.String }),
]);
export type LeaseClaimOutput = typeof LeaseClaimOutputSchema.Type;

const LeaseProbeInputSchema = Schema.Struct({
  lockPath: Schema.optionalKey(Schema.String),
});

export const LeaseProbeOutputSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("free"), heldBy: Schema.Null }),
  Schema.Struct({
    state: Schema.Literal("busy"),
    heldBy: Schema.NullOr(LeaseHolderSchema),
  }),
  Schema.Struct({ state: Schema.Literal("error"), error: Schema.String }),
]);
export type LeaseProbeOutput = typeof LeaseProbeOutputSchema.Type;

const leaseProcedures = {
  claim: {
    input: LeaseClaimInputSchema,
    output: LeaseClaimOutputSchema,
  },
  probe: {
    input: LeaseProbeInputSchema,
    output: LeaseProbeOutputSchema,
  },
  release: {
    input: Schema.Struct({}),
    output: Schema.Struct({ ok: Schema.Boolean }),
  },
} as const;

export const laneSurface = defineSurface({
  ...nodePrimitives,
  procedures: {
    node: nodeProcedures,
    snapshot: {
      has: {
        input: Schema.Struct({ origin: Schema.String, commit: Schema.String }),
        output: Schema.Struct({ present: Schema.Boolean }),
      },
      put: {
        input: Schema.Struct({ commit: Schema.String, offset: Schema.Int, total: Schema.Int, data: Schema.String }),
        output: Schema.Struct({ ok: Schema.Boolean, error: Schema.NullOr(Schema.String), received: Schema.Int }),
      },
    },
    run: {
      configure: {
        input: ConfigureInputSchema,
        output: ConfigureOutputSchema,
      },
      extend: {
        input: ExtendInputSchema,
        output: ConfigureOutputSchema,
      },
    },
    lease: leaseProcedures,
  },
});

export type LaneClient = SurfaceClientOf<typeof laneSurface.spec>;

export function laneClientOver(dispatch: SurfaceDispatch): LaneClient {
  return buildSurfaceFace(laneSurface, dispatch) as unknown as LaneClient;
}
