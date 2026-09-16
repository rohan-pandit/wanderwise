/**
 * Candidate combination assembly (PROJECT_BRIEF.md §8.6 step 5, §9.6). Builds
 * budget-feasible flight + hotel + activities bundles from already
 * hard-constraint-filtered candidates — in particular, hotels are assumed to
 * have already passed a room-capacity check (e.g. `minRoomCapacityConstraint`
 * from `./constraints`) for `travelers`, so this only ever books one room.
 * This is the deterministic planning baseline that runs before any AI
 * ranking/explanation — it only decides what *fits*, not what's most
 * appealing; scheduling feasibility (dates, opening hours, overlaps) is a
 * separate concern handled by `validateItineraryFeasibility` once a
 * combination has been turned into a dated draft.
 */
import { calculateBudget, type BudgetBreakdown, type BudgetInput } from "./budget";
import type { Activity } from "@/src/repositories/activities";
import type { Flight } from "@/src/repositories/flights";
import type { Hotel } from "@/src/repositories/hotels";

export interface CombinationParams {
  flights: Flight[];
  hotels: Hotel[];
  activities: Activity[];
  travelers: number;
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
  const maxActivities = params.maxActivities ?? DEFAULT_MAX_ACTIVITIES;
  const activitiesByPrice = [...params.activities].sort((a, b) => a.price_usd - b.price_usd);

  const combinations: CandidateCombination[] = [];

  for (const flight of params.flights) {
    for (const hotel of params.hotels) {
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

      combinations.push({ flight, hotel, activities: included, budget });
    }
  }

  return combinations.sort((a, b) => {
    if (a.activities.length !== b.activities.length) {
      return b.activities.length - a.activities.length;
    }
    return a.budget.totalEstimate.amount - b.budget.totalEstimate.amount;
  });
}
