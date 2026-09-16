/**
 * Candidate combination assembly (PROJECT_BRIEF.md §8.6 step 5, §9.6). Builds
 * budget-feasible flight + hotel + activities bundles from already
 * hard-constraint-filtered candidates. This is the deterministic planning
 * baseline that runs before any AI ranking/explanation — it only decides
 * what *fits*, not what's most appealing; scheduling feasibility (dates,
 * opening hours, overlaps) is a separate concern handled by
 * `validateItineraryFeasibility` once a combination has been turned into a
 * dated draft.
 *
 * A hotel books one room per entry in `roomGroups` (e.g. parents and kids in
 * separate rooms, or a group of friends wanting their own room), not one
 * room for the whole party. Hotels are still assumed to have passed
 * `roomCapacityConstraint` (from `./constraints`) upstream, but that trust
 * is defense-in-depth here too: a hotel whose `room_capacity` can't fit the
 * largest room group is skipped rather than silently under-costed.
 */
import { calculateBudget, type BudgetBreakdown, type BudgetInput } from "./budget";
import { assertRoomGroupsMatchTravelers, maxRoomOccupancy, type RoomGroup } from "./rooms";
import type { Activity } from "@/src/repositories/activities";
import type { Flight } from "@/src/repositories/flights";
import type { Hotel } from "@/src/repositories/hotels";

export interface CombinationParams {
  flights: Flight[];
  hotels: Hotel[];
  activities: Activity[];
  travelers: number;
  /** Must account for every traveler exactly once — throws `RoomConfigurationError` otherwise. One room is booked per entry. */
  roomGroups: RoomGroup[];
  nights: number;
  targetUsd: number;
  /** Defaults to `targetUsd`. */
  ceilingUsd?: number;
  /** Caps how many activities one combination bundles in. Defaults to 6. */
  maxActivities?: number;
}

export interface CandidateCombination {
  flight: Flight;
  hotel: Hotel;
  /** Rooms booked at `hotel`, one per input room group. */
  rooms: number;
  activities: Activity[];
  budget: BudgetBreakdown;
}

const DEFAULT_MAX_ACTIVITIES = 6;

function isOverCeiling(budget: BudgetBreakdown): boolean {
  return budget.violations.some((v) => v.code === "CEILING_EXCEEDED");
}

/**
 * Cross-joins flights and hotels, then greedily fills each pair with the
 * cheapest activities that still fit under the ceiling. Pairs that don't fit
 * the ceiling on their own (before any activities) are dropped rather than
 * silently weakening the ceiling. Returns combinations ranked by how many
 * activities they include (more is better), then by lowest total cost.
 */
export function assembleCandidateCombinations(
  params: CombinationParams,
): CandidateCombination[] {
  assertRoomGroupsMatchTravelers(params.roomGroups, params.travelers);

  const maxActivities = params.maxActivities ?? DEFAULT_MAX_ACTIVITIES;
  const activitiesByPrice = [...params.activities].sort((a, b) => a.price_usd - b.price_usd);
  const rooms = params.roomGroups.length;
  const requiredRoomCapacity = maxRoomOccupancy(params.roomGroups);

  const combinations: CandidateCombination[] = [];

  for (const flight of params.flights) {
    for (const hotel of params.hotels) {
      if (hotel.room_capacity < requiredRoomCapacity) continue;

      const budgetFor = (activities: Activity[]): BudgetBreakdown => {
        const input: BudgetInput = {
          currency: "USD",
          travelers: params.travelers,
          targetUsd: params.targetUsd,
          ceilingUsd: params.ceilingUsd,
          flights: [{ priceUsd: flight.price_usd, taxesFeesUsd: flight.taxes_fees_usd }],
          hotel: {
            pricePerNightUsd: hotel.price_per_night_usd,
            taxesFeesUsd: hotel.taxes_fees_usd,
            nights: params.nights,
            rooms,
          },
          activities: activities.map((a) => ({
            id: a.id,
            priceUsd: a.price_usd,
            partySize: params.travelers,
          })),
        };
        return calculateBudget(input);
      };

      const baseBudget = budgetFor([]);
      if (isOverCeiling(baseBudget)) continue;

      const included: Activity[] = [];
      let budget = baseBudget;
      for (const activity of activitiesByPrice) {
        if (included.length >= maxActivities) break;
        const candidateBudget = budgetFor([...included, activity]);
        if (isOverCeiling(candidateBudget)) continue;
        included.push(activity);
        budget = candidateBudget;
      }

      combinations.push({ flight, hotel, rooms, activities: included, budget });
    }
  }

  return combinations.sort((a, b) => {
    if (a.activities.length !== b.activities.length) {
      return b.activities.length - a.activities.length;
    }
    return a.budget.totalEstimate.amount - b.budget.totalEstimate.amount;
  });
}
