/**
 * THE VENUES, for the service — the machines, and the holds on them.
 *
 * `odu hosts`, `odu lease` and `odu release` were the last three public
 * commands that reached the fleet from whatever process the operator happened
 * to type in. Through these three ports the DAEMON reaches it, which is what
 * makes the inventory a browser sees and the inventory a terminal sees the same
 * inventory, taken at one place, with one vocabulary for a machine's state.
 *
 * The logic is not re-derived here: `./hosts` and `./leaseCmd` already own it
 * and now return it as data. This module is the seam, and the seam is where the
 * two behavioural consequences of moving the caller are written down — see
 * {@link holdVenue}, and `spawnLeaseHold`'s note on whose child a holder now is.
 */

import { venueInventory } from "./hosts";
import { leaseVenues, releaseVenues } from "./leaseCmd";
import type {
  VenueHolder,
  VenueProber,
  VenueReleaser,
} from "@odu/service/ports";

/** Probe the configured venues — every one, or only the platforms named. Dials
 *  each machine it was asked about, and acquires nothing. */
export const probeVenues: VenueProber = venueInventory;

/**
 * Take a hold on a venue, for a checkout, that outlives the caller.
 *
 * **NON-BLOCKING, always.** The terminal's `odu lease` polled until the box was
 * its own, printing progress; a service call cannot, because the queue it joins
 * is somebody else's run and that can be an hour long. So a hold that is not
 * immediately available answers `waiting` with `waitingBehind` — a complete
 * answer, not a partial one: the holder is already spawned and queueing, and
 * `venue.probe` is where the caller watches it land.
 *
 * `noWait` is untouched by that and means what it always did — it is the
 * HOLDER's persistence, not this call's: with it, the holder tries once and
 * exits rather than queueing at all.
 */
export const holdVenue: VenueHolder = (request) =>
  leaseVenues({
    repoRoot: request.checkout,
    platforms: request.platforms,
    hostsFile: request.hostsFile,
    noWait: request.noWait,
  });

/** Drop a checkout's holds. No refusal arm: releasing what is not held is the
 *  outcome `nothing`, which is what makes a lost reply safe to retry. */
export const releaseVenue: VenueReleaser = (request) =>
  Promise.resolve(
    releaseVenues({
      repoRoot: request.checkout,
      platforms: request.platforms,
      hostsFile: request.hostsFile,
    }),
  );
