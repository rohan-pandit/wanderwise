/**
 * The flight step of the stepwise chain redesign
 * (`docs/IMPLEMENTATION_PLAN.md`'s "STEPWISE CHAIN REDESIGN" section,
 * decided 2026-09-17) — slice 1. Deliberately scoped to the flight step
 * alone: the old one-shot pipeline (`search-orchestrator.ts`,
 * `itinerary-orchestrator.ts`) stays live and untouched; nothing is rewired
 * yet.
 *
 * Two decisions from this slice's planning session, not assumed:
 * 1. Before a hotel/activities exist to fit a budget against, this proposes
 *    a **short ranked list** (top 3 cheapest hard-constraint-passing
 *    outbound+return pairs), not a single "cheapest wins" pick — the user
 *    chose this explicitly so a bare "I don't like this one" rejection has
 *    somewhere to go (point at a different list item) without needing
 *    exclusion-tracking machinery.
 * 2. This module never calls `advanceTrip`/touches `WorkflowState` — it
 *    only reads `trip_requirements` (gated by the existing deterministic
 *    `checkRequirementsComplete`, not by `trips.status`) and writes
 *    `trip_decisions`, with the same guardrail/trip_events telemetry
 *    conventions as every other orchestrator. How the coarse workflow
 *    states get reused across three repeated steps is deliberately deferred
 *    until hotel + activities also exist and the chat loop is rebuilt.
 *
 * `proposeFlightStep` returns candidates without persisting anything —
 * ephemeral, same pattern `runSearchAndCuration` already uses. Since the
 * user picks one explicitly from a visible list, there's no need for the
 * `trip_decisions.status = "proposed"` intermediate here: `confirmFlightStep`
 * is the sole persistence point, writing directly as `"confirmed"`.
 *
 * No separate "revise" function exists this slice: a requirement change
 * (e.g. a future `maxFlightPriceUsd` revision) just means calling
 * `proposeFlightStep` again — it always reads current active requirements
 * fresh. The chat-level "detect 'cheaper' -> revise a requirement ->
 * re-propose" wiring needs `intake-orchestrator.ts` to become step-aware,
 * which is out of scope until a later slice.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/src/config/supabase/database.types";
import { filterHardConstraints } from "@/src/domain/constraints";
import {
  checkRequirementsComplete,
  type ExtractionSource,
  type RequirementFieldName,
  type RequirementRecord,
} from "@/src/domain/extraction";
import { deriveHotelStayDates, type HotelStayDates } from "@/src/domain/stay";
import { appendTripDecision, retireActiveTripDecisionsForField } from "@/src/repositories/trip-decisions";
import { appendTripEvent } from "@/src/repositories/trip-events";
import { findFlights, getFlightsByIds, type Flight } from "@/src/repositories/flights";
import { recordGuardrailEvent } from "@/src/repositories/guardrail-events";
import { listActiveTripRequirements, type TripRequirementRow } from "@/src/repositories/trip-requirements";
import { getOrCreateActiveWorkflowRun } from "@/src/repositories/workflow-runs";
import { deriveCorrelationId } from "./correlation";
import { flightHardConstraints, requirementMap } from "./search-orchestrator";
import { OneWayTripNotSupportedError } from "./itinerary-orchestrator";

const AGENT_NAME = "flight_step";
const MAX_FLIGHT_CANDIDATES = 3;

export class RequirementsNotReadyError extends Error {
  constructor(tripId: string, missingFields: RequirementFieldName[]) {
    super(`Trip ${tripId}: requirements aren't ready yet — missing: ${missingFields.join(", ")}.`);
    this.name = "RequirementsNotReadyError";
  }
}

export class NoViableFlightCandidatesError extends Error {
  constructor(tripId: string, detail: string) {
    super(`Trip ${tripId}: no viable flight candidates — ${detail}`);
    this.name = "NoViableFlightCandidatesError";
  }
}

export class InvalidFlightSelectionError extends Error {
  constructor(tripId: string, detail: string) {
    super(`Trip ${tripId}: invalid flight selection — ${detail}`);
    this.name = "InvalidFlightSelectionError";
  }
}

function toRequirementRecords(rows: TripRequirementRow[]): RequirementRecord[] {
  return rows.map((row) => ({
    id: row.id,
    field: row.field as RequirementFieldName,
    value: row.value,
    source: row.source as ExtractionSource,
    confidence: row.confidence ?? 1,
    status: row.status as RequirementRecord["status"],
    createdAt: row.created_at,
  }));
}

export interface FlightStepCandidate {
  outboundFlight: Flight;
  returnFlight: Flight;
  totalPriceUsd: number;
}

export interface ProposeFlightStepParams {
  tripId: string;
  /** Idempotency key for the logged `trip_events` row — see `deriveCorrelationId`. Defaults to a fresh UUID if omitted. */
  correlationId?: string;
}

export interface ProposeFlightStepResult {
  /** Best-first, up to `MAX_FLIGHT_CANDIDATES` — nothing is persisted yet. */
  candidates: FlightStepCandidate[];
}

/**
 * Searches and hard-constraint-filters outbound + reversed-direction return
 * flights from the trip's active requirements, then proposes the top
 * cheapest passing pairs. Purely deterministic — no model call.
 */
export async function proposeFlightStep(
  supabase: SupabaseClient<Database>,
  params: ProposeFlightStepParams,
): Promise<ProposeFlightStepResult> {
  const correlationId = params.correlationId ?? randomUUID();

  const requirementRows = await listActiveTripRequirements(supabase, params.tripId);
  const completeness = checkRequirementsComplete(toRequirementRecords(requirementRows));
  if (!completeness.ready) {
    throw new RequirementsNotReadyError(params.tripId, completeness.missingFields);
  }

  const reqs = requirementMap(requirementRows);
  const origin = reqs.get("origin") as string;
  const destination = reqs.get("destination") as string;
  const departureDate = reqs.get("departureDate") as string;
  const returnDate = reqs.get("returnDate") as string | undefined;
  if (!returnDate) {
    throw new OneWayTripNotSupportedError(params.tripId);
  }

  const [run, outboundCandidates, returnCandidates] = await Promise.all([
    getOrCreateActiveWorkflowRun(supabase, params.tripId),
    findFlights(supabase, {
      origin,
      destination,
      departureDate,
      maxPriceUsd: reqs.get("maxFlightPriceUsd") as number | undefined,
      excludeRedEye: reqs.get("noRedEye") === true,
    }),
    findFlights(supabase, {
      origin: destination,
      destination: origin,
      departureDate: returnDate,
      maxPriceUsd: reqs.get("maxFlightPriceUsd") as number | undefined,
      excludeRedEye: reqs.get("noRedEye") === true,
    }),
  ]);

  const constraints = flightHardConstraints(reqs);
  const outboundFilter = filterHardConstraints(outboundCandidates, constraints);
  const returnFilter = filterHardConstraints(returnCandidates, constraints);

  await Promise.all([
    recordGuardrailEvent(supabase, {
      tripId: params.tripId,
      agentName: AGENT_NAME,
      guardrailName: "outbound_flight_hard_constraints",
      layer: "domain_validation",
      triggered: outboundFilter.rejected.length > 0,
      detail: outboundFilter.rejected.length
        ? `${outboundFilter.rejected.length} of ${outboundCandidates.length} outbound flight(s) rejected: ${[...new Set(outboundFilter.rejected.map((r) => r.code))].join(", ")}`
        : null,
      workflowRunId: run.id,
    }),
    recordGuardrailEvent(supabase, {
      tripId: params.tripId,
      agentName: AGENT_NAME,
      guardrailName: "return_flight_hard_constraints",
      layer: "domain_validation",
      triggered: returnFilter.rejected.length > 0,
      detail: returnFilter.rejected.length
        ? `${returnFilter.rejected.length} of ${returnCandidates.length} return flight(s) rejected: ${[...new Set(returnFilter.rejected.map((r) => r.code))].join(", ")}`
        : null,
      workflowRunId: run.id,
    }),
  ]);

  if (outboundFilter.passing.length === 0 || returnFilter.passing.length === 0) {
    const missing: string[] = [];
    if (outboundFilter.passing.length === 0) missing.push("no outbound flights passed hard constraints");
    if (returnFilter.passing.length === 0) missing.push("no return flights passed hard constraints");
    throw new NoViableFlightCandidatesError(params.tripId, missing.join("; "));
  }

  const candidates: FlightStepCandidate[] = [];
  for (const outboundFlight of outboundFilter.passing) {
    for (const returnFlight of returnFilter.passing) {
      candidates.push({
        outboundFlight,
        returnFlight,
        totalPriceUsd: outboundFlight.price_usd + returnFlight.price_usd,
      });
    }
  }
  candidates.sort((a, b) => a.totalPriceUsd - b.totalPriceUsd);
  const topCandidates = candidates.slice(0, MAX_FLIGHT_CANDIDATES);

  await appendTripEvent(supabase, {
    tripId: params.tripId,
    eventType: "flight_step_proposed",
    payload: {
      candidates: topCandidates.map((c) => ({
        outboundFlightId: c.outboundFlight.id,
        returnFlightId: c.returnFlight.id,
        totalPriceUsd: c.totalPriceUsd,
      })),
    } as unknown as Json,
    correlationId: deriveCorrelationId(correlationId, "event:flight_step_proposed"),
  });

  return { candidates: topCandidates };
}

export interface ConfirmFlightStepParams {
  tripId: string;
  outboundFlightId: string;
  returnFlightId: string;
  /** Idempotency key for the logged `trip_events` row — see `deriveCorrelationId`. Defaults to a fresh UUID if omitted. */
  correlationId?: string;
}

export interface ConfirmFlightStepResult {
  outboundFlight: Flight;
  returnFlight: Flight;
  /** The fact slice 2's hotel step will need — computed now even though nothing consumes it yet. */
  hotelStayDates: HotelStayDates;
}

/**
 * Persists the user's chosen outbound+return pair as confirmed decisions.
 * Re-validates both IDs against the trip's current requirements/hard
 * constraints first (defense in depth against a stale or tampered ID,
 * consistent with house style) rather than trusting the caller already
 * checked.
 */
export async function confirmFlightStep(
  supabase: SupabaseClient<Database>,
  params: ConfirmFlightStepParams,
): Promise<ConfirmFlightStepResult> {
  const correlationId = params.correlationId ?? randomUUID();

  const requirementRows = await listActiveTripRequirements(supabase, params.tripId);
  const reqs = requirementMap(requirementRows);
  const origin = reqs.get("origin") as string;
  const destination = reqs.get("destination") as string;

  const [outboundRows, returnRows] = await Promise.all([
    getFlightsByIds(supabase, [params.outboundFlightId]),
    getFlightsByIds(supabase, [params.returnFlightId]),
  ]);
  const outboundFlight = outboundRows[0];
  const returnFlight = returnRows[0];
  if (!outboundFlight || !returnFlight) {
    throw new InvalidFlightSelectionError(params.tripId, "one or both flight IDs don't resolve to real inventory.");
  }
  if (outboundFlight.origin !== origin || outboundFlight.destination !== destination) {
    throw new InvalidFlightSelectionError(
      params.tripId,
      `outbound flight ${outboundFlight.id} (${outboundFlight.origin} -> ${outboundFlight.destination}) doesn't match the trip's route (${origin} -> ${destination}).`,
    );
  }
  if (returnFlight.origin !== destination || returnFlight.destination !== origin) {
    throw new InvalidFlightSelectionError(
      params.tripId,
      `return flight ${returnFlight.id} (${returnFlight.origin} -> ${returnFlight.destination}) doesn't match the trip's return route (${destination} -> ${origin}).`,
    );
  }

  const constraints = flightHardConstraints(reqs);
  const failing = filterHardConstraints([outboundFlight, returnFlight], constraints).rejected;
  if (failing.length > 0) {
    throw new InvalidFlightSelectionError(
      params.tripId,
      `no longer passes hard constraints: ${failing.map((f) => `${f.candidate.id} (${f.code})`).join(", ")}`,
    );
  }

  await retireActiveTripDecisionsForField(supabase, params.tripId, "outboundFlight");
  await appendTripDecision(supabase, {
    tripId: params.tripId,
    field: "outboundFlight",
    value: outboundFlight.id,
    source: "user_explicit",
    status: "confirmed",
  });
  await retireActiveTripDecisionsForField(supabase, params.tripId, "returnFlight");
  await appendTripDecision(supabase, {
    tripId: params.tripId,
    field: "returnFlight",
    value: returnFlight.id,
    source: "user_explicit",
    status: "confirmed",
  });

  await appendTripEvent(supabase, {
    tripId: params.tripId,
    eventType: "flight_step_confirmed",
    payload: { outboundFlightId: outboundFlight.id, returnFlightId: returnFlight.id } as unknown as Json,
    correlationId: deriveCorrelationId(correlationId, "event:flight_step_confirmed"),
  });

  return { outboundFlight, returnFlight, hotelStayDates: deriveHotelStayDates(outboundFlight, returnFlight) };
}
