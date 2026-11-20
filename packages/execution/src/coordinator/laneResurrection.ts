export function maxLaneResurrections(env = process.env): number {
  const raw = env.ODU_MAX_LANE_RESURRECTIONS;
  if (raw === undefined || raw === "") return 2;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 2;
}
