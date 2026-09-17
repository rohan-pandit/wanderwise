/**
 * The chain/cascade data model for the stepwise redesign
 * (`docs/IMPLEMENTATION_PLAN.md`'s "STEPWISE CHAIN REDESIGN" section,
 * decided 2026-09-17). Pure and fully unit-tested here, ahead of most of it
 * having a live caller — slice 1 only builds the flight step, so the
 * hotel/activities branches below are exercised by tests, not by any
 * orchestrator yet (the plan's own words: "the derived-fact cascade check in
 * place, even though nothing downstream exists yet to actually cascade to").
 *
 * The chain is strictly linear: destination/dates (requirements) -> flight
 * -> hotel -> activities. Each step is proposed and explicitly confirmed
 * before the next is even searched. Cascading invalidation is fact-based,
 * not position-based: a change only invalidates a later step if it actually
 * alters the specific fact that step depends on.
 */
import type { RequirementFieldName } from "./extraction";

export const CHAIN_STEPS = ["flight", "hotel", "activities"] as const;
export type ChainStep = (typeof CHAIN_STEPS)[number];

/** The `trip_decisions.field` value(s) that make up each step — the flight step spans two decision fields (outbound + return), confirmed together. */
export const STEP_DECISION_FIELDS: Record<ChainStep, readonly string[]> = {
  flight: ["outboundFlight", "returnFlight"],
  hotel: ["hotel"],
  activities: ["activities"],
};

export interface ChainDecision {
  field: string;
  status: string;
}

/**
 * The first step (in chain order) that isn't fully confirmed yet, or
 * `"complete"` once every step's decision field(s) are. Derived from
 * `trip_decisions` rather than stored, matching the codebase's existing
 * preference for deterministic derived checks (`checkRequirementsComplete`)
 * over a separately-tracked mutable flag that could drift out of sync.
 */
export function getCurrentChainStep(decisions: ChainDecision[]): ChainStep | "complete" {
  const confirmedFields = new Set(decisions.filter((d) => d.status === "confirmed").map((d) => d.field));
  for (const step of CHAIN_STEPS) {
    const allConfirmed = STEP_DECISION_FIELDS[step].every((field) => confirmedFields.has(field));
    if (!allConfirmed) return step;
  }
  return "complete";
}

/**
 * Which chain step a given requirement field is "about." `"foundational"`
 * fields (destination, dates, party size, room groups, budget) are inputs
 * every step depends on — changing one invalidates the whole chain from
 * "flight" onward, not just whichever step happens to read it directly.
 * Every field is classified here (not a partial map) so a new
 * `RequirementFieldName` can't slip in unclassified. Mirrors exactly how
 * `src/workflow/search-orchestrator.ts` already consumes each field today —
 * not a new judgment call, just making the existing dependency explicit.
 */
export const REQUIREMENT_FIELD_STEP: Record<RequirementFieldName, ChainStep | "foundational"> = {
  origin: "foundational",
  destination: "foundational",
  departureDate: "foundational",
  returnDate: "foundational",
  partySize: "foundational",
  roomGroups: "foundational",
  budgetTotalUsd: "foundational",
  noRedEye: "flight",
  maxFlightPriceUsd: "flight",
  minHotelRating: "hotel",
  refundableHotel: "hotel",
  requiredAccessibility: "activities",
  excludeClosedOnDays: "activities",
  maxActivityPriceUsd: "activities",
};

function stepsFrom(step: ChainStep): ChainStep[] {
  return CHAIN_STEPS.slice(CHAIN_STEPS.indexOf(step));
}

/** A foundational requirement change invalidates the whole chain; a step-specific field invalidates that step onward. */
export function invalidatedStepsForRequirementField(field: RequirementFieldName): ChainStep[] {
  const target = REQUIREMENT_FIELD_STEP[field];
  return target === "foundational" ? stepsFrom("flight") : stepsFrom(target);
}

/**
 * A flight change only invalidates hotel/activities if the newly-chosen
 * flight's derived check-in/check-out dates actually differ from before
 * (compare via `src/domain/stay.ts`'s `deriveHotelStayDates`). A same-dates
 * flight swap (different airline/time, same calendar days) leaves hotel and
 * activities untouched.
 */
export function invalidatedStepsForFlightChange(datesChanged: boolean): ChainStep[] {
  return datesChanged ? stepsFrom("flight") : ["flight"];
}

/** A hotel change never invalidates activities: scheduling depends only on the stay's date range (which comes from the flight) and each activity's own hours/closed days — never on which hotel was picked. */
export function invalidatedStepsForHotelChange(): ChainStep[] {
  return ["hotel"];
}

/** Activities is the last step — nothing further downstream to invalidate. */
export function invalidatedStepsForActivitiesChange(): ChainStep[] {
  return ["activities"];
}
