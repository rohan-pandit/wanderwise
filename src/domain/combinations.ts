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
 *
 * `flights` is a one-way table (`supabase/migrations/0001_initial_schema.sql`
 * — one `origin`/`destination`/`departure_time`/`arrival_time` per row), so a
 * round trip needs two legs. `returnFlights` is optional: omit it (or pass
 * `[]`) for a one-way trip (no `returnDate` stated), and every combination's
 * `returnFlight` comes back `null` with no return-leg cost. `calculateBudget`'s
 * `BudgetInput.flights` was already an array specifically to hold more than
 * one leg — this was the first caller to actually feed it two.
 */
import { calculateBudget, type BudgetBreakdown, type BudgetInput } from "./budget";
import { assertRoomGroupsMatchTravelers, maxRoomOccupancy, type RoomGroup } from "./rooms";
import type { Activity } from "@/src/repositories/activities";
import type { Flight } from "@/src/repositories/flights";
import type { Hotel } from "@/src/repositories/hotels";

/** The only fields `assembleCandidateCombinations` itself needs from an activity — generic so it also accepts `MatchedActivity` (Phase 5 retrieval's projection, which lacks `embedding`) without an unsafe cast. */
export interface ActivityCandidate {
  id: string;
  price_usd: number;
}

export interface CombinationParams<A extends ActivityCandidate = Activity> {
  outboundFlights: Flight[];
  /** Return-leg candidates. Omit (or pass `[]`) for a one-way trip. */
  returnFlights?: Flight[];
  hotels: Hotel[];
  activities: A[];
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

export interface CandidateCombination<A extends ActivityCandidate = Activity> {
  outboundFlight: Flight;
  /** `null` for a one-way trip (no `returnFlights` given). */
  returnFlight: Flight | null;
  hotel: Hotel;
  /** Rooms booked at `hotel`, one per input room group. */
  rooms: number;
  activities: A[];
  budget: BudgetBreakdown;
}

const DEFAULT_MAX_ACTIVITIES = 6;

function isOverCeiling(budget: BudgetBreakdown): boolean {
  return budget.violations.some((v) => v.code === "CEILING_EXCEEDED");
}

/**
 * Cross-joins outbound flights, return flights (or just the one-way case
 * when none are given), and hotels, then greedily fills each triple with the
 * cheapest activities that still fit under the ceiling. Combinations that
 * don't fit the ceiling on their own (before any activities) are dropped
 * rather than silently weakening the ceiling. Returns combinations ranked by
 * how many activities they include (more is better), then by lowest total
 * cost.
 */
export function assembleCandidateCombinations<A extends ActivityCandidate = Activity>(
  params: CombinationParams<A>,
): CandidateCombination<A>[] {
  assertRoomGroupsMatchTravelers(params.roomGroups, params.travelers);

  const maxActivities = params.maxActivities ?? DEFAULT_MAX_ACTIVITIES;
  const activitiesByPrice = [...params.activities].sort((a, b) => a.price_usd - b.price_usd);
  const rooms = params.roomGroups.length;
  const requiredRoomCapacity = maxRoomOccupancy(params.roomGroups);
  const returnCandidates: (Flight | null)[] = params.returnFlights?.length ? params.returnFlights : [null];

  const combinations: CandidateCombination<A>[] = [];

  for (const outboundFlight of params.outboundFlights) {
    for (const returnFlight of returnCandidates) {
      for (const hotel of params.hotels) {
        if (hotel.room_capacity < requiredRoomCapacity) continue;

        const budgetFor = (activities: A[]): BudgetBreakdown => {
          const flightLegs = [{ priceUsd: outboundFlight.price_usd, taxesFeesUsd: outboundFlight.taxes_fees_usd }];
          if (returnFlight) {
            flightLegs.push({ priceUsd: returnFlight.price_usd, taxesFeesUsd: returnFlight.taxes_fees_usd });
          }
          const input: BudgetInput = {
            currency: "USD",
            travelers: params.travelers,
            targetUsd: params.targetUsd,
            ceilingUsd: params.ceilingUsd,
            flights: flightLegs,
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

        const included: A[] = [];
        let budget = baseBudget;
        for (const activity of activitiesByPrice) {
          if (included.length >= maxActivities) break;
          const candidateBudget = budgetFor([...included, activity]);
          if (isOverCeiling(candidateBudget)) continue;
          included.push(activity);
          budget = candidateBudget;
        }

        combinations.push({ outboundFlight, returnFlight, hotel, rooms, activities: included, budget });
      }
    }
  }

  return combinations.sort((a, b) => {
    if (a.activities.length !== b.activities.length) {
      return b.activities.length - a.activities.length;
    }
    return a.budget.totalEstimate.amount - b.budget.totalEstimate.amount;
  });
}
