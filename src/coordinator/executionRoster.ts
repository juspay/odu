import type { Lane } from "./lane";
import type { LeaseHandle } from "./lease";

export interface ExecutionLane {
  handle: Lane;
  publicId(localId: string): string;
  routes: Map<string, string>;
}

interface PlatformExecution {
  cancelled: boolean;
  lanes: ExecutionLane[];
  leases: Set<LeaseHandle>;
}

/** Runtime ownership and routing for a platform, independent of lane count. */
export class ExecutionRoster {
  readonly #platforms = new Map<string, PlatformExecution>();
  readonly #release: (lease: LeaseHandle) => void;

  constructor(release: (lease: LeaseHandle) => void) {
    this.#release = release;
  }

  #for(platform: string): PlatformExecution {
    const current = this.#platforms.get(platform);
    if (current !== undefined) return current;
    const created: PlatformExecution = {
      cancelled: false,
      lanes: [],
      leases: new Set(),
    };
    this.#platforms.set(platform, created);
    return created;
  }

  ensure(platform: string): void {
    this.#for(platform);
  }

  accepts(platform: string): boolean {
    const execution = this.#platforms.get(platform);
    return execution !== undefined && !execution.cancelled;
  }

  isCancelled(platform: string): boolean {
    return this.#platforms.get(platform)?.cancelled === true;
  }

  addLease(platform: string, lease: LeaseHandle): boolean {
    const execution = this.#for(platform);
    if (execution.cancelled) return false;
    execution.leases.add(lease);
    return true;
  }

  releaseLease(platform: string, lease: LeaseHandle): void {
    if (!this.#platforms.get(platform)?.leases.delete(lease)) return;
    this.#release(lease);
  }

  /** Every lease this platform currently owns, as a snapshot safe to iterate
   *  while releasing. */
  leasesFor(platform: string): LeaseHandle[] {
    return [...(this.#platforms.get(platform)?.leases ?? [])];
  }

  addLane(
    platform: string,
    handle: Lane,
    localIds: readonly string[],
    publicId: (localId: string) => string,
  ): void {
    const execution = this.#for(platform);
    if (execution.cancelled) {
      handle.close();
      return;
    }
    execution.lanes.push({
      handle,
      publicId,
      routes: new Map(localIds.map((localId) => [publicId(localId), localId])),
    });
  }

  /** Forget one lane and every route it owned. For a lane being REPLACED — a
   *  dead primary whose successor is about to be registered for the same
   *  nodes: leaving the corpse in would keep it first in `route`'s scan (so a
   *  rerun would be dispatched to a closed session) and would keep it in
   *  `lanes()`, where the log drain would stamp truncation notices on nodes
   *  the run is about to run again. Does NOT close the lane — the caller
   *  decides how it dies. */
  dropLane(platform: string, handle: Lane): void {
    const execution = this.#platforms.get(platform);
    if (execution === undefined) return;
    const index = execution.lanes.findIndex((entry) => entry.handle === handle);
    if (index < 0) return;
    execution.lanes.splice(index, 1);
  }

  /** Add routes after a lane receives its deferred task phase. */
  extendLane(
    platform: string,
    handle: Lane,
    localIds: readonly string[],
    publicId: (localId: string) => string,
  ): boolean {
    const execution = this.#platforms.get(platform);
    if (execution === undefined || execution.cancelled) return false;
    const lane = execution.lanes.find((entry) => entry.handle === handle);
    if (lane === undefined) return false;
    for (const localId of localIds) {
      lane.routes.set(publicId(localId), localId);
    }
    return true;
  }

  route(
    platform: string,
    publicId: string,
  ): { lane: Lane; localId: string } | undefined {
    const execution = this.#platforms.get(platform);
    if (execution === undefined || execution.cancelled) return undefined;
    for (const lane of execution.lanes) {
      const localId = lane.routes.get(publicId);
      if (localId !== undefined) return { lane: lane.handle, localId };
    }
    return undefined;
  }

  cancel(platform: string): boolean {
    const execution = this.#platforms.get(platform);
    if (execution?.cancelled === true) return true;
    if (execution === undefined) return false;
    execution.cancelled = true;
    for (const lane of execution.lanes) lane.handle.close();
    for (const lease of [...execution.leases]) {
      execution.leases.delete(lease);
      this.#release(lease);
    }
    return true;
  }

  lanes(): ExecutionLane[] {
    return [...this.#platforms.values()].flatMap((value) => value.lanes);
  }
}
