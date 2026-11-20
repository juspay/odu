import type { TaskSpec } from "../common/spec";
import type { ClaimWindow } from "./claimWindows";

export function maxLaneResurrections(env = process.env): number {
  const raw = env.ODU_MAX_LANE_RESURRECTIONS;
  if (raw === undefined || raw === "") return 2;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 2;
}

export interface Attempt {
  platform: string;
  attempt: number;
  of: number;
}

export interface LaneEpisodes {
  current(platform: string): number;
  stale(platform: string, episode: number): boolean;
  bump(platform: string, episode: number): Attempt | null;
}

export function laneEpisodes(max = maxLaneResurrections()): LaneEpisodes {
  const episodes = new Map<string, number>();
  const current = (platform: string): number => episodes.get(platform) ?? 0;
  return {
    current,
    stale: (platform, episode) => episode !== current(platform),
    bump: (platform, episode) => {
      if (episode !== current(platform)) return null;
      if (episode >= max) return null;
      const attempt = episode + 1;
      episodes.set(platform, attempt);
      return { platform, attempt, of: max };
    },
  };
}

export interface RetryPlan {
  attempt: Attempt;
  reason: string;
  tasks: TaskSpec[];
  ids: ReadonlySet<string>;
}

export interface VacatedLane {
  plan: RetryPlan;
  window: ClaimWindow;
}
