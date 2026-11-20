import { venueInventory } from "./venueInventory";
import { leaseVenues, releaseVenues } from "./leaseVenues";
import type {
  VenueHolder,
  VenueProber,
  VenueReleaser,
} from "@odu/service/ports";

export const probeVenues: VenueProber = venueInventory;

export const holdVenue: VenueHolder = (request) =>
  leaseVenues({
    repoRoot: request.checkout,
    platforms: request.platforms,
    caller: request.caller,
    noWait: request.noWait,
  });

export const releaseVenue: VenueReleaser = (request) =>
  Promise.resolve(
    releaseVenues({
      repoRoot: request.checkout,
      platforms: request.platforms,
    }),
  );
