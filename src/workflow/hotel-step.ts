/**
 * The hotel step of the stepwise chain redesign
 * (`docs/IMPLEMENTATION_PLAN.md`'s "STEPWISE CHAIN REDESIGN" section,
 * decided 2026-09-17) — slice 2. Mirrors `flight-step.ts`'s shape and
 * decisions exactly (same reasoning applies, not re-litigated per field):
 * a short ranked list (top 3 cheapest hard-constraint-passing hotels), no
 * `WorkflowState`/`advanceTrip` involvement, `proposeHotelStep` returns
 * ephemeral candidates, `confirmHotelStep` is the sole persistence point.
 *
 * The one thing genuinely new here: this step can only be proposed once the
 * flight step is confirmed, since its check-in/check-out dates are derived
 * from the confirmed flight's real arrival/departure times
 * (`src/domain/stay.ts`'s `deriveHotelStayDates`) — proposing a hotel before
 * a flight is confirmed would be proposing against a guess. Per rule 3 of
 * the decided design, confirming (or re-confirming) a hotel never
 * invalidates activities — scheduling depends only on the stay's date range
 * (which comes from the flight) and each activity's own hours/closed days,
 * never on which hotel was picked — so `confirmHotelStep` has no cascade
 * logic of its own, unlike `flight-step.ts`'s `confirmFlightStep`.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/src/config/supabase/database.types";
import { filterHardConstraints } from "@/src/domain/constraints";
import type { RoomGroup } from "@/src/domain/rooms";
import { deriveHotelStayDates, type HotelStayDates } from "@/src/domain/stay";
import { getFlightsByIds } from "@/src/repositories/flights";
import { recordGuardrailEvent } from "@/src/repositories/guardrail-events";
import { findHotels, getHotelsByIds, type Hotel } from "@/src/repositories/hotels";
import { appendTripDecision, listActiveTripDecisions, retireActiveTripDecisionsForField } from "@/src/repositories/trip-decisions";
import { appendTripEvent } from "@/src/repositories/trip-events";
import { listActiveTripRequirements } from "@/src/repositories/trip-requirements";
import { getOrCreateActiveWorkflowRun } from "@/src/repositories/workflow-runs";
import { deriveCorrelationId } from "./correlation";
import { hotelHardConstraints, requirementMap } from "./search-orchestrator";

const AGENT_NAME = "hotel_step";
const MAX_HOTEL_CANDIDATES = 3;

export class FlightStepNotConfirmedError extends Error {
  constructor(tripId: string) {
    super(`Trip ${tripId}: the flight step must be confirmed before the hotel step can be proposed.`);
    this.name = "FlightStepNotConfirmedError";
  }
}

export class NoViableHotelCandidatesError extends Error {
  constructor(tripId: string, detail: string) {
    super(`Trip ${tripId}: no viable hotel candidates — ${detail}`);
    this.name = "NoViableHotelCandidatesError";
  }
}

export class InvalidHotelSelectionError extends Error {
  constructor(tripId: string, detail: string) {
    super(`Trip ${tripId}: invalid hotel selection — ${detail}`);
    this.name = "InvalidHotelSelectionError";
  }
}

function confirmedDecisionValue(decisions: { field: string; status: string; value: Json }[], field: string): string | undefined {
  return decisions.find((d) => d.field === field && d.status === "confirmed")?.value as string | undefined;
}

async function loadConfirmedStayDates(
  supabase: SupabaseClient<Database>,
  tripId: string,
): Promise<HotelStayDates> {
  const decisions = await listActiveTripDecisions(supabase, tripId);
  const outboundId = confirmedDecisionValue(decisions, "outboundFlight");
  const returnId = confirmedDecisionValue(decisions, "returnFlight");
  if (!outboundId || !returnId) {
    throw new FlightStepNotConfirmedError(tripId);
  }
  const [outboundRows, returnRows] = await Promise.all([
    getFlightsByIds(supabase, [outboundId]),
    getFlightsByIds(supabase, [returnId]),
  ]);
  const outboundFlight = outboundRows[0];
  const returnFlight = returnRows[0];
  if (!outboundFlight || !returnFlight) {
    throw new Error(`Trip ${tripId}: confirmed flight decisions reference missing inventory.`);
  }
  return deriveHotelStayDates(outboundFlight, returnFlight);
}

export interface ProposeHotelStepParams {
  tripId: string;
  /** Idempotency key for the logged `trip_events` row — see `deriveCorrelationId`. Defaults to a fresh UUID if omitted. */
  correlationId?: string;
}

export interface ProposeHotelStepResult {
  /** Best-first (cheapest per night), up to `MAX_HOTEL_CANDIDATES` — nothing is persisted yet. */
  candidates: Hotel[];
  /** The confirmed flight's derived stay dates this search was scoped to. */
  hotelStayDates: HotelStayDates;
}

/**
 * Searches and hard-constraint-filters hotels for the destination, scoped to
 * the confirmed flight's derived stay dates, then proposes the top cheapest
 * passing hotels. Purely deterministic — no model call.
 */
export async function proposeHotelStep(
  supabase: SupabaseClient<Database>,
  params: ProposeHotelStepParams,
): Promise<ProposeHotelStepResult> {
  const correlationId = params.correlationId ?? randomUUID();

  const hotelStayDates = await loadConfirmedStayDates(supabase, params.tripId);

  const [requirementRows, run] = await Promise.all([
    listActiveTripRequirements(supabase, params.tripId),
    getOrCreateActiveWorkflowRun(supabase, params.tripId),
  ]);
  const reqs = requirementMap(requirementRows);
  const destination = reqs.get("destination") as string;
  const partySize = reqs.get("partySize") as number;
  const roomGroups = (reqs.get("roomGroups") as RoomGroup[] | undefined) ?? [{ occupants: partySize }];

  const hotelCandidates = await findHotels(supabase, {
    destination,
    minRating: reqs.get("minHotelRating") as number | undefined,
  });

  const constraints = hotelHardConstraints(reqs, roomGroups);
  const filtered = filterHardConstraints(hotelCandidates, constraints);

  await recordGuardrailEvent(supabase, {
    tripId: params.tripId,
    agentName: AGENT_NAME,
    guardrailName: "hotel_hard_constraints",
    layer: "domain_validation",
    triggered: filtered.rejected.length > 0,
    detail: filtered.rejected.length
      ? `${filtered.rejected.length} of ${hotelCandidates.length} hotel(s) rejected: ${[...new Set(filtered.rejected.map((r) => r.code))].join(", ")}`
      : null,
    workflowRunId: run.id,
  });

  if (filtered.passing.length === 0) {
    throw new NoViableHotelCandidatesError(params.tripId, "no hotels passed hard constraints");
  }

  // `findHotels` already orders by price_per_night_usd ascending and
  // `filterHardConstraints` preserves order — cheapest-first falls out
  // without a separate sort.
  const topCandidates = filtered.passing.slice(0, MAX_HOTEL_CANDIDATES);

  await appendTripEvent(supabase, {
    tripId: params.tripId,
    eventType: "hotel_step_proposed",
    payload: {
      candidates: topCandidates.map((h) => ({ hotelId: h.id, pricePerNightUsd: h.price_per_night_usd })),
      checkIn: hotelStayDates.checkIn,
      checkOut: hotelStayDates.checkOut,
    } as unknown as Json,
    correlationId: deriveCorrelationId(correlationId, "event:hotel_step_proposed"),
  });

  return { candidates: topCandidates, hotelStayDates };
}

export interface ConfirmHotelStepParams {
  tripId: string;
  hotelId: string;
  /** Idempotency key for the logged `trip_events` row — see `deriveCorrelationId`. Defaults to a fresh UUID if omitted. */
  correlationId?: string;
}

export interface ConfirmHotelStepResult {
  hotel: Hotel;
}

/**
 * Persists the user's chosen hotel as a confirmed decision. Re-validates
 * the ID against the trip's current requirements/hard constraints first
 * (defense in depth, same as `confirmFlightStep`) rather than trusting the
 * caller already checked. Never touches activities — see the module
 * docstring.
 */
export async function confirmHotelStep(
  supabase: SupabaseClient<Database>,
  params: ConfirmHotelStepParams,
): Promise<ConfirmHotelStepResult> {
  const correlationId = params.correlationId ?? randomUUID();

  const [hotelRows, requirementRows] = await Promise.all([
    getHotelsByIds(supabase, [params.hotelId]),
    listActiveTripRequirements(supabase, params.tripId),
  ]);
  const hotel = hotelRows[0];
  if (!hotel) {
    throw new InvalidHotelSelectionError(params.tripId, "hotel id doesn't resolve to real inventory.");
  }

  const reqs = requirementMap(requirementRows);
  const destination = reqs.get("destination") as string;
  if (hotel.destination !== destination) {
    throw new InvalidHotelSelectionError(
      params.tripId,
      `hotel ${hotel.id} belongs to destination "${hotel.destination}", not the trip's destination "${destination}".`,
    );
  }

  const partySize = reqs.get("partySize") as number;
  const roomGroups = (reqs.get("roomGroups") as RoomGroup[] | undefined) ?? [{ occupants: partySize }];
  const constraints = hotelHardConstraints(reqs, roomGroups);
  const failing = filterHardConstraints([hotel], constraints).rejected;
  if (failing.length > 0) {
    throw new InvalidHotelSelectionError(
      params.tripId,
      `no longer passes hard constraints: ${failing.map((f) => f.code).join(", ")}`,
    );
  }

  await retireActiveTripDecisionsForField(supabase, params.tripId, "hotel");
  await appendTripDecision(supabase, {
    tripId: params.tripId,
    field: "hotel",
    value: hotel.id,
    source: "user_explicit",
    status: "confirmed",
  });

  await appendTripEvent(supabase, {
    tripId: params.tripId,
    eventType: "hotel_step_confirmed",
    payload: { hotelId: hotel.id } as unknown as Json,
    correlationId: deriveCorrelationId(correlationId, "event:hotel_step_confirmed"),
  });

  return { hotel };
}
