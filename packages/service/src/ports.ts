import type { CatalogOptions } from "@odu/run-history/store";
import type { RunScope } from "@odu/run-history/schema";
import type { Caller } from "./caller";
import type { BranchName, Sha } from "./refs";

export interface LaunchPush {
  readonly substituter: string;
  /** `Odu-Origin`: where the push is aimed. */
  readonly origin: string;
  readonly bucket: string;
  readonly tokenId: string;
  readonly token: string;
}

export interface LaunchRequest {
  readonly checkout: string;
  readonly catalog?: CatalogOptions;
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly requestId: string | null;
  readonly scope: RunScope;
  readonly expectedSha: string;
  readonly noStrict: boolean;
  readonly noSnapshot: boolean;
  readonly noPost: boolean;
  readonly hostPins: readonly string[];
  readonly caller: Caller;
  readonly supersede: boolean;
  readonly linger: boolean;
  readonly push: LaunchPush | null;
  readonly pushSkipped: string | null;
  readonly pushKeyWarning: string | null;
  readonly checkoutMoved: string | null;
}

export interface LaunchReceipt {
  ok: boolean;
  runId: string;
  endpoint: string;
  pid?: number;
  lifetime?: string;
  error?: string;
}

export type RunLauncher = (request: LaunchRequest) => Promise<LaunchReceipt>;

export interface PushTarget {
  readonly substituter: string;
  /** `Odu-Origin`: where a push is aimed. */
  readonly origin: string;
  /** `Odu-Bucket`: which bucket at that origin. */
  readonly bucket: string;
  readonly keyWarning: string | null;
}

export type PushResolution =
  | { readonly kind: "target"; readonly target: PushTarget }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "ambiguous"; readonly substituters: readonly string[] };

export interface PushGrant {
  readonly tokenId: string;
  readonly token: string;
}

export interface PushPort {
  resolve: (checkout: string) => Promise<PushResolution>;
  grant: (request: { bucket: string; runId: string }) => PushGrant | null;
  revoke: (tokenId: string) => void;
}

export interface RetryReceipt {
  request_id: string | null;
  mode: "live" | "relaunched";
  effective_run: string;
  parent_run: string | null;
  roots: readonly string[];
  reset_dependants: readonly string[];
  attempts: readonly { node: string; attempt: number }[];
  scope: RunScope;
  sha: string;
  cursor: string;
  lifetime?: string;
}

export type RetryRefusal =
  | "bad_input"
  | "unknown_run"
  | "not_replayable"
  | "request_conflict"
  | "request_unresolved"
  | "stale_attempt"
  | "partial"
  | "launch_failed"
  | "no_venue"
  | "expired";

export type RetryOutcome =
  | { ok: true; receipt: RetryReceipt; replayed: boolean }
  | {
      ok: false;
      code: RetryRefusal;
      message: string;
      suggestion?: readonly string[];
    };

export interface RetryRequest {
  runId: string;
  selector: string;
  requestId?: string;
  expectAttempt?: { node: string; attempt: number };
  catalog?: CatalogOptions;
}

export type RunRetrier = (request: RetryRequest) => Promise<RetryOutcome>;

export type CancelScope =
  | { kind: "run" }
  | { kind: "node"; node: string }
  | { kind: "lane"; platform: string };

export interface CoordinatorIdentity {
  readonly endpoint: string;
  readonly sha: string;
  readonly seq: number | null;
}

export interface CancelRequest {
  coordinator: CoordinatorIdentity;
  runId: string;
  scope: CancelScope;
}

export type CancelOutcome =
  | { kind: "cancelled"; detail: string | null }
  | { kind: "declined"; detail: string }
  | { kind: "unresolved"; detail: string };

export type ConfirmedOutcome = Exclude<CancelOutcome, { kind: "unresolved" }>;

export type RunCanceller = (request: CancelRequest) => Promise<CancelOutcome>;

export interface CheckoutFacts {
  isRepo: boolean;
  head: string | null;
  branch: string | null;
  liveRunId: string | null;
}

export type CheckoutProbe = (checkout: string) => CheckoutFacts;

export interface CheckoutMoveRequest {
  readonly checkout: string;
  readonly branch: BranchName;
  readonly sha: Sha;
}

export type CheckoutMoveOutcome =
  | { readonly kind: "moved"; readonly head: string }
  | { readonly kind: "dirty"; readonly detail: string }
  | { readonly kind: "fetch_failed"; readonly detail: string }
  | { readonly kind: "not_on_branch"; readonly tip: string }
  | { readonly kind: "failed"; readonly detail: string };

export type CheckoutMover = (
  request: CheckoutMoveRequest,
) => Promise<CheckoutMoveOutcome>;

export interface TaskFacts {
  readonly id: string;
  readonly name: string | null;
  readonly command: string;
  readonly needs: readonly string[];
  readonly os: readonly string[];
  readonly shards: number | null;
}

export interface PipelineFacts {
  readonly name: string;
  readonly tasks: readonly TaskFacts[];
  readonly mermaid: string;
}

export type PipelineOutcome =
  | { ok: true; facts: PipelineFacts }
  | { ok: false; message: string };

export type PipelineReader = (request: {
  checkout: string;
  root?: string;
}) => PipelineOutcome;

export interface VenueHolderFacts {
  readonly holder: string;
  readonly run: string | null;
  readonly sinceMs: number;
}

export interface VenueRowFacts {
  readonly platform: string;
  readonly host: string;
  readonly slot: number;
  readonly slots: number;
  readonly state: "probing" | "free" | "busy" | "local" | "down";
  readonly heldBy: VenueHolderFacts | null;
  readonly error: string | null;
}

export type VenueProbeOutcome =
  | {
      ok: true;
      source: string | null;
      warnings: readonly string[];
      rows: readonly VenueRowFacts[];
    }
  | { ok: false; message: string };

export type VenueProber = (request: {
  platforms: readonly string[];
  caller: Caller;
  onReading?: (partial: {
    source: string | null;
    warnings: readonly string[];
    rows: readonly VenueRowFacts[];
  }) => void;
}) => Promise<VenueProbeOutcome>;

export interface VenueHoldResult {
  readonly platform: string;
  readonly status: "held" | "waiting" | "already";
  readonly host: string | null;
  readonly holderPid: number | null;
  readonly waitingBehind: VenueHolderFacts | null;
  readonly message: string;
}

export type VenueHoldOutcome =
  | { ok: true; results: readonly VenueHoldResult[] }
  | { ok: false; message: string };

export type VenueHolder = (request: {
  checkout: string;
  platforms: readonly string[];
  caller: Caller;
  noWait: boolean;
}) => Promise<VenueHoldOutcome>;

export interface VenueReleaseResult {
  readonly platform: string;
  readonly effective: "released" | "nothing";
  readonly host: string | null;
  readonly detail: string | null;
}

export type VenueReleaser = (request: {
  checkout: string;
  platforms: readonly string[];
  caller: Caller;
}) => Promise<{ results: readonly VenueReleaseResult[] }>;

export interface ProtectFacts {
  readonly repo: string | null;
  readonly branch: string | null;
  readonly contexts: readonly string[];
  readonly rulesetId: number | null;
  readonly applied: boolean;
  readonly created: boolean;
  readonly derivedFrom: string | null;
  readonly detail: string | null;
}

export type ProtectOutcome =
  | { ok: true; facts: ProtectFacts }
  | {
      ok: false;
      code: "checkout_refused" | "pipeline_refused" | "no_credential" | "bad_input";
      message: string;
      suggestion?: readonly string[];
    };

export type RulesetWriter = (request: {
  checkout: string;
  branch?: string;
  platforms: readonly string[];
  caller: Caller;
  dryRun: boolean;
  create: boolean;
}) => Promise<ProtectOutcome>;

export interface ServicePorts {
  launch: RunLauncher;
  retry: RunRetrier;
  cancel: RunCanceller;
  push: PushPort;
  probeCheckout: CheckoutProbe;
  moveCheckout: CheckoutMover;
  pipeline: PipelineReader;
  probeVenues: VenueProber;
  holdVenue: VenueHolder;
  releaseVenue: VenueReleaser;
  protect: RulesetWriter;
}
