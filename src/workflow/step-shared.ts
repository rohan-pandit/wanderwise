/**
 * Small helpers shared across the stepwise chain's step modules
 * (`flight-step.ts`, `hotel-step.ts`, `activities-step.ts`) and
 * `intake-orchestrator.ts`. Originally lived on `search-orchestrator.ts`/
 * `itinerary-orchestrator.ts` (the one-shot pipeline those steps replace);
 * relocated here when that pipeline was retired (stepwise chain redesign
 * slice 3, `docs/IMPLEMENTATION_PLAN.md`) since these are genuinely
 * reusable, not specific to the pipeline that used to own them.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/src/config/supabase/database.types";
import type { ChainStep } from "@/src/domain/chain";
import type { HardConstraint } from "@/src/domain/constraints";
import {
  maxFlightPriceConstraint,
  maxHotelPriceConstraint,
  minHotelRatingConstraint,
  noRedEyeConstraint,
  refundableConstraint,
  roomAvailabilityConstraint,
  roomCapacityConstraint,
} from "@/src/domain/constraints";
import type { RequirementFieldName } from "@/src/domain/extraction";
import { CURRENT_INVENTORY_VERSION } from "@/src/domain/inventory";
import type { RoomGroup } from "@/src/domain/rooms";
import { getDestinationByName, type Destination } from "@/src/repositories/destinations";
import type { Flight } from "@/src/repositories/flights";
import type { Hotel } from "@/src/repositories/hotels";
import {
  appendTripDecision,
  confirmTripDecisions,
  retireActiveTripDecisionsForField,
  supersedeOtherActiveTripDecisions,
  type TripDecisionRow,
} from "@/src/repositories/trip-decisions";
import type { TripRequirementRow } from "@/src/repositories/trip-requirements";

export function requirementMap(rows: TripRequirementRow[]): Map<RequirementFieldName, unknown> {
  const map = new Map<RequirementFieldName, unknown>();
  for (const row of rows) map.set(row.field as RequirementFieldName, row.value);
  return map;
}

/** A cancelled trip (`state-machine.ts`'s `cancel` event/`cancelled` terminal state) is terminal — no further action should be able to mutate it. Lives here (not `app/app/actions.ts`, a `"use server"` file that can only export async functions) so every Server Action can import and throw it. */
export class TripCancelledError extends Error {
  constructor(tripId: string) {
    super(`Trip ${tripId} has been cancelled — no further changes can be made to it.`);
    this.name = "TripCancelledError";
  }
}

/** A trip's stated `destination` requirement doesn't resolve to any real `destinations` row — inventory we simply don't cover, distinct from "no viable candidates" (docs/IMPLEMENTATION_PLAN.md §5). */
export class UnknownDestinationError extends Error {
  constructor(tripId: string, destinationName: string) {
    super(`Trip ${tripId}'s destination "${destinationName}" doesn't match any known destination.`);
    this.name = "UnknownDestinationError";
  }
}

/**
 * Resolves a trip's free-text `destination` requirement to its real
 * `destinations` row once, at the point a step actually needs it — closes
 * the identifier-space gap `docs/IMPLEMENTATION_PLAN.md` §5 tracked (`flights`/
 * `hotels`/`activities` used to match `destination` by name alone, with no
 * shared key against `destinations.name`, which isn't even guaranteed
 * unique). Deliberately resolved lazily per step call rather than once at
 * intake time and persisted — intake-time resolution would need new
 * deterministic workflow-state plumbing to override the Intake agent's own
 * clarification decision, or exposing the destinations catalog to the model;
 * lazy resolution closes the same gap with far less surface, and still
 * surfaces an unresolvable destination in the same chat turn, since
 * `sendMessage` auto-chains straight into the flight step once
 * `requirements_ready` is reached.
 */
export async function resolveTripDestination(
  supabase: SupabaseClient<Database>,
  reqs: Map<RequirementFieldName, unknown>,
  tripId: string,
): Promise<Destination> {
  const destinationName = reqs.get("destination") as string;
  const destination = await getDestinationByName(supabase, destinationName, CURRENT_INVENTORY_VERSION);
  if (!destination) {
    throw new UnknownDestinationError(tripId, destinationName);
  }
  return destination;
}

export function flightHardConstraints(reqs: Map<RequirementFieldName, unknown>): HardConstraint<Flight>[] {
  const constraints: HardConstraint<Flight>[] = [];
  if (reqs.get("noRedEye") === true) constraints.push(noRedEyeConstraint());
  const maxFlightPriceUsd = reqs.get("maxFlightPriceUsd");
  if (typeof maxFlightPriceUsd === "number") constraints.push(maxFlightPriceConstraint(maxFlightPriceUsd));
  return constraints;
}

export function hotelHardConstraints(reqs: Map<RequirementFieldName, unknown>, roomGroups: RoomGroup[]): HardConstraint<Hotel>[] {
  const constraints: HardConstraint<Hotel>[] = [roomCapacityConstraint(roomGroups), roomAvailabilityConstraint(roomGroups)];
  const minHotelRating = reqs.get("minHotelRating");
  if (typeof minHotelRating === "number") constraints.push(minHotelRatingConstraint(minHotelRating));
  const maxHotelPriceUsd = reqs.get("maxHotelPriceUsd");
  if (typeof maxHotelPriceUsd === "number") constraints.push(maxHotelPriceConstraint(maxHotelPriceUsd));
  if (reqs.get("refundableHotel") === true) constraints.push(refundableConstraint());
  return constraints;
}

/**
 * Persists a confirmed value for a decision field, promoting a matching
 * `"proposed"` candidate in place when one exists (stepwise chain redesign
 * slice 4 — `propose*Step` now persists its candidate list as `"proposed"`
 * rows) rather than always retiring-and-reinserting. `supersedeOtherActiveTripDecisions`
 * clears both sibling proposed candidates and any prior `"confirmed"` row
 * for the field, so this is correct both for a first-ever confirm (nothing
 * else to supersede) and for revising an already-confirmed step (a fresh
 * proposed list coexists with the still-confirmed old pick until one of the
 * new candidates is promoted here). Falls back to the original
 * retire-then-insert-as-confirmed behavior when no matching proposed row is
 * found (e.g. a direct `confirm*Step` call with no prior `propose*Step`
 * call, which every existing test that doesn't call `propose*Step` first
 * still does).
 */
export async function confirmDecisionField(
  supabase: SupabaseClient<Database>,
  tripId: string,
  field: string,
  value: Json,
  activeDecisions: TripDecisionRow[],
): Promise<void> {
  const proposedMatch = activeDecisions.find((d) => d.field === field && d.status === "proposed" && d.value === value);
  if (proposedMatch) {
    await supersedeOtherActiveTripDecisions(supabase, tripId, field, proposedMatch.id);
    await confirmTripDecisions(supabase, tripId, [field]);
    return;
  }
  await retireActiveTripDecisionsForField(supabase, tripId, field);
  await appendTripDecision(supabase, { tripId, field, value, source: "user_explicit", status: "confirmed" });
}

/**
 * Chain steps (`src/domain/chain.ts`'s `ChainStep`) `propose_trip_revision`
 * can target for a `revisionType: "decision"` revision (stepwise chain
 * redesign slice 4 — replaces the old flat `outboundFlight`/`returnFlight`/
 * `hotel` field-name vocabulary now that a decision revision routes through
 * `src/workflow/step-router.ts`'s per-step `reviseChainStep`, not a specific
 * `trip_decisions` field). "activities" stays excluded — which specific
 * activity to swap needs more than a step name to resolve, a carried-forward
 * scope limit, not a new gap.
 */
export const REVISABLE_CHAIN_STEPS: readonly ChainStep[] = ["flight", "hotel"];
