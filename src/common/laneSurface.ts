/**
 * `laneSurface` — the contract `odu-runner --stdio` serves on each platform's
 * host, and the coordinator's private protocol with it.
 *
 * It is the same state vocabulary the fan-in speaks: `nodePrimitives` (the
 * `nodes` cell + the `nodeLog` stream) and `nodeProcedures` (`node.rerun` /
 * `node.cancel`) are imported from `@odu/run-client/surface` and spread here,
 * so a lane frame and the fan-in frame the coordinator re-serves it as can
 * never disagree. Onto them the lane adds the two things only an agent has:
 *
 *   - `run.configure` — the pipeline recipe, sent once per lane (a second call
 *     errors);
 *   - `lease.*` — the venue flock on the agent (claim / probe / release).
 *
 * It is PRIVATE, which is why it did not go into `@odu/run-client` with the
 * fan-in surface: the runner is pinned to the build that shipped its
 * coordinator (`runnerFlake.ts`, no override), so both ends of this wire always
 * ship together and there is no third party to publish it to. The package's
 * README argues the cut.
 *
 * The runner spawns idle (HostSession argv is fixed to `--stdio`); the
 * coordinator dials it over surface-remote for both the pool lease and the CI
 * lane.
 *
 * The zod→Effect Schema mapping is LAW here as on the fan-in (kolu PLAN #17):
 * `.optional()` → `Schema.optionalKey`, never `Schema.optional`, because absent
 * means ABSENT on this wire too. The encoded bytes of `ConfigureInput` and both
 * lease output unions are frozen — they cross the stdio wire to `odu-runner`,
 * and `schemaBytes.test.ts` pins them.
 */

import { buildSurfaceFace } from "@kolu/surface/client";
import { defineSurface } from "@kolu/surface/define";
import type { SurfaceDispatch } from "@kolu/surface/link";
import type { SurfaceClientOf } from "@kolu/surface/project";
import { Schema } from "effect";
import { nodePrimitives, nodeProcedures } from "@odu/run-client/surface";
import { TaskSpecSchema } from "./spec";

/** `run.configure` input: either `workspace` (a checkout the runner can use
 *  as-is — the coordinator's HEAD snapshot on a localhost lane) or
 *  `origin` + `sha` (the runner fetches the pushed SHA into a per-SHA
 *  worktree under ~/.cache/odu). */
export const ConfigureInputSchema = Schema.Struct({
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

/** Who holds a venue lock (`holder|run|sinceMs` on the agent). Shared by the
 *  lane's `lease.*` procedures and the coordinator's `odu hosts` rendering. */
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
  /** Absolute path on the agent host. Omit → agent default (`ODU_LEASE_LOCK`
   *  or {@link DEFAULT_LEASE_LOCK}). `optionalKey`, so a caller with no override
   *  must OMIT the key — spelling it `undefined` is a decode failure. */
  lockPath: Schema.optionalKey(Schema.String),
});

/** Discriminated on `status`, not `_tag` — `Schema.Union` keeps the frozen
 *  bytes; `TaggedUnion` would rename the discriminant. */
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

/** Discriminated on `state` — same reasoning as {@link LeaseClaimOutputSchema}. */
export const LeaseProbeOutputSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("free"), heldBy: Schema.Null }),
  Schema.Struct({
    state: Schema.Literal("busy"),
    heldBy: Schema.NullOr(LeaseHolderSchema),
  }),
  Schema.Struct({ state: Schema.Literal("error"), error: Schema.String }),
]);
export type LeaseProbeOutput = typeof LeaseProbeOutputSchema.Type;

/** Venue lock on the lane agent — non-blocking claim/probe/release.
 *  Flock is local to the agent process (util-linux on odu-runner's Nix PATH);
 *  the coordinator dials this surface over surface-remote, never a bash
 *  claim script. Hold lifetime = agent session: release RPC or process death
 *  frees the lock. */
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

/** Served by `odu-runner --stdio` on each lane host. */
export const laneSurface = defineSurface({
  ...nodePrimitives,
  procedures: {
    node: nodeProcedures,
    run: {
      configure: {
        input: ConfigureInputSchema,
        output: ConfigureOutputSchema,
      },
    },
    lease: leaseProcedures,
  },
});

/** The lane agent's face (`odu-runner --stdio`): `nodes`, `nodeLog`, plus
 *  `node.*`, `run.configure` and `lease.*`. */
export type LaneClient = SurfaceClientOf<typeof laneSurface.spec>;

/** Build the lane face over any dispatch — the same ONE-cast arrangement
 *  `oduClientOver` makes for the fan-in, and for the same reason: the runtime
 *  object carries every member the type names, and the cast only tells the
 *  compiler which projection of `buildSurfaceFace`'s walk it is looking at. */
export function laneClientOver(dispatch: SurfaceDispatch): LaneClient {
  return buildSurfaceFace(laneSurface, dispatch) as unknown as LaneClient;
}
