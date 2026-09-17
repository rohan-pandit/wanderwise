/**
 * Small helpers shared across the stepwise chain's step modules
 * (`flight-step.ts`, `hotel-step.ts`, `activities-step.ts`) and
 * `intake-orchestrator.ts`. Originally lived on `search-orchestrator.ts`/
 * `itinerary-orchestrator.ts` (the one-shot pipeline those steps replace);
 * relocated here when that pipeline was retired (stepwise chain redesign
 * slice 3, `docs/IMPLEMENTATION_PLAN.md`) since these are genuinely
 * reusable, not specific to the pipeline that used to own them.
 */
import type { HardConstraint } from "@/src/domain/constraints";
import { maxFlightPriceConstraint, minHotelRatingConstraint, noRedEyeConstraint, refundableConstraint, roomCapacityConstraint } from "@/src/domain/constraints";
import type { RequirementFieldName } from "@/src/domain/extraction";
import type { RoomGroup } from "@/src/domain/rooms";
import type { Flight } from "@/src/repositories/flights";
import type { Hotel } from "@/src/repositories/hotels";
import type { TripRequirementRow } from "@/src/repositories/trip-requirements";

export class OneWayTripNotSupportedError extends Error {
  constructor(tripId: string) {
    super(`Trip ${tripId} has no returnDate — the stepwise chain can't derive a hotel-stay length or checkout date for a one-way trip yet.`);
    this.name = "OneWayTripNotSupportedError";
  }
}

export function requirementMap(rows: TripRequirementRow[]): Map<RequirementFieldName, unknown> {
  const map = new Map<RequirementFieldName, unknown>();
  for (const row of rows) map.set(row.field as RequirementFieldName, row.value);
  return map;
}

export function flightHardConstraints(reqs: Map<RequirementFieldName, unknown>): HardConstraint<Flight>[] {
  const constraints: HardConstraint<Flight>[] = [];
  if (reqs.get("noRedEye") === true) constraints.push(noRedEyeConstraint());
  const maxFlightPriceUsd = reqs.get("maxFlightPriceUsd");
  if (typeof maxFlightPriceUsd === "number") constraints.push(maxFlightPriceConstraint(maxFlightPriceUsd));
  return constraints;
}

export function hotelHardConstraints(reqs: Map<RequirementFieldName, unknown>, roomGroups: RoomGroup[]): HardConstraint<Hotel>[] {
  const constraints: HardConstraint<Hotel>[] = [roomCapacityConstraint(roomGroups)];
  const minHotelRating = reqs.get("minHotelRating");
  if (typeof minHotelRating === "number") constraints.push(minHotelRatingConstraint(minHotelRating));
  if (reqs.get("refundableHotel") === true) constraints.push(refundableConstraint());
  return constraints;
}

/**
 * Decision fields `intake-orchestrator.ts` can route to a step's re-propose
 * (`app/app/actions.ts`'s `runStepwiseRevision`) from a chat-detected
 * `propose_trip_revision` call with `revisionType: "decision"`. Unchanged
 * from the old pipeline's equivalent list — "activities" still isn't
 * revisable this way (which specific activity to swap needs more than a
 * field name to resolve), so this isn't a new gap, just a carried-forward
 * one.
 */
export type RevisableDecisionField = "outboundFlight" | "returnFlight" | "hotel";
export const REVISABLE_DECISION_FIELDS: readonly RevisableDecisionField[] = ["outboundFlight", "returnFlight", "hotel"];
