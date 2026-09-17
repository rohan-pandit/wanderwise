/**
 * The flight step of the stepwise chain redesign
 * (`docs/IMPLEMENTATION_PLAN.md`'s "STEPWISE CHAIN REDESIGN" section,
 * decided 2026-09-17) — slice 1, with slice 2's flight->hotel cascade rule
 * added to `confirmFlightStep` once `hotel-step.ts` gave it something real
 * to invalidate, and slice 3 generalizing that same cascade to activities
 * once `activities-step.ts` existed too. The old one-shot pipeline
 * (`search-orchestrator.ts`, `itinerary-orchestrator.ts`) was retired in
 * slice 3 — `flightHardConstraints`/`requirementMap` moved to
 * `step-shared.ts`, the only pieces of it this module ever depended on.
 *
 * `returnDate` became a required field (`REQUIRED_FOR_READY`,
 * `src/domain/extraction.ts`) once one-way trips were resolved to "ask for a
 * return date via clarification" rather than a silent default — so
 * `checkRequirementsComplete` below now rejects a missing `returnDate` the
 * same way it rejects a missing `destination`, and the dedicated
 * `OneWayTripNotSupportedError` this module used to throw afterward was
 * removed as dead code once completeness already guaranteed its presence.
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
 * `proposeFlightStep` persists its ranked candidate list as `"proposed"`
 * `trip_decisions` rows (stepwise chain redesign slice 4) so a real UI can
 * render candidate cards that survive a page reload — a change from slices
 * 1-3, where candidates were purely ephemeral. `confirmFlightStep` promotes
 * the picked pair's matching proposed row in place (via `step-shared.ts`'s
 * `confirmDecisionField`) rather than always retiring-and-reinserting, and
 * falls back to the original retire-then-insert behavior if no matching
 * proposed row exists (e.g. a direct `confirmFlightStep` call with no prior
 * `proposeFlightStep` call).
 *
 * No separate "revise" function exists this slice: a requirement change
 * (e.g. a future `maxFlightPriceUsd` revision) just means calling
 * `proposeFlightStep` again — it always reads current active requirements
 * fresh.
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
import { invalidatedStepsForFlightChange } from "@/src/domain/chain";
import {
  appendTripDecision,
  listActiveTripDecisions,
  retireActiveTripDecisionsForField,
  retireProposedTripDecisionsForField,
} from "@/src/repositories/trip-decisions";
import { appendTripEvent } from "@/src/repositories/trip-events";
import { findFlights, getFlightsByIds, type Flight } from "@/src/repositories/flights";
import { recordGuardrailEvent } from "@/src/repositories/guardrail-events";
import { listActiveTripRequirements, type TripRequirementRow } from "@/src/repositories/trip-requirements";
import { getOrCreateActiveWorkflowRun } from "@/src/repositories/workflow-runs";
import { deriveCorrelationId } from "./correlation";
import { confirmDecisionField, flightHardConstraints, requirementMap, resolveTripDestination } from "./step-shared";

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
  /** Excludes any pair whose outbound leg is this ID — used by a revision re-propose so "show me something else" can't just return the same pick again. */
  excludeOutboundFlightId?: string;
  /** Excludes any pair whose return leg is this ID. */
  excludeReturnFlightId?: string;
}

export interface ProposeFlightStepResult {
  /** Best-first, up to `MAX_FLIGHT_CANDIDATES` — also persisted as "proposed" `trip_decisions` rows. */
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
  const departureDate = reqs.get("departureDate") as string;
  // Guaranteed present: `returnDate` is in `REQUIRED_FOR_READY`, so the
  // completeness check above already rejected a missing value.
  const returnDate = reqs.get("returnDate") as string;

  const [run, destinationRow] = await Promise.all([
    getOrCreateActiveWorkflowRun(supabase, params.tripId),
    resolveTripDestination(supabase, reqs, params.tripId),
  ]);

  const [outboundCandidates, returnCandidates] = await Promise.all([
    findFlights(supabase, {
      origin,
      destinationId: destinationRow.id,
      departureDate,
      maxPriceUsd: reqs.get("maxFlightPriceUsd") as number | undefined,
      excludeRedEye: reqs.get("noRedEye") === true,
    }),
    findFlights(supabase, {
      originId: destinationRow.id,
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
    if (params.excludeOutboundFlightId && outboundFlight.id === params.excludeOutboundFlightId) continue;
    for (const returnFlight of returnFilter.passing) {
      if (params.excludeReturnFlightId && returnFlight.id === params.excludeReturnFlightId) continue;
      candidates.push({
        outboundFlight,
        returnFlight,
        totalPriceUsd: outboundFlight.price_usd + returnFlight.price_usd,
      });
    }
  }
  if (candidates.length === 0) {
    throw new NoViableFlightCandidatesError(params.tripId, "no other pair is available once the excluded flight(s) are ruled out");
  }
  candidates.sort((a, b) => a.totalPriceUsd - b.totalPriceUsd);
  const topCandidates = candidates.slice(0, MAX_FLIGHT_CANDIDATES);

  // Persist the ranked list as "proposed" (stepwise chain redesign slice 4)
  // so the UI can render candidate cards that survive a page reload, and so
  // `confirmFlightStep` can promote the picked pair in place rather than
  // retiring and reinserting it.
  await retireProposedTripDecisionsForField(supabase, params.tripId, "outboundFlight");
  await retireProposedTripDecisionsForField(supabase, params.tripId, "returnFlight");
  for (const candidate of topCandidates) {
    await appendTripDecision(supabase, {
      tripId: params.tripId,
      field: "outboundFlight",
      value: candidate.outboundFlight.id,
      source: "system_computed",
      status: "proposed",
    });
    await appendTripDecision(supabase, {
      tripId: params.tripId,
      field: "returnFlight",
      value: candidate.returnFlight.id,
      source: "system_computed",
      status: "proposed",
    });
  }

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
 *
 * If this trip already has a confirmed flight (i.e. this call is a
 * revision, not the first confirmation), this is also where the
 * flight->hotel cascade rule (`src/domain/chain.ts`'s
 * `invalidatedStepsForFlightChange`) gets its first real caller: a
 * confirmed hotel decision is retired (superseded, forcing the hotel step
 * to be re-proposed) only if the newly-confirmed flight's derived
 * check-in/check-out dates actually differ from the previous confirmation's
 * — a same-dates flight swap (different airline/time, same calendar days)
 * leaves an already-confirmed hotel untouched.
 */
export async function confirmFlightStep(
  supabase: SupabaseClient<Database>,
  params: ConfirmFlightStepParams,
): Promise<ConfirmFlightStepResult> {
  const correlationId = params.correlationId ?? randomUUID();

  const [requirementRows, priorDecisions] = await Promise.all([
    listActiveTripRequirements(supabase, params.tripId),
    listActiveTripDecisions(supabase, params.tripId),
  ]);
  const reqs = requirementMap(requirementRows);
  const origin = reqs.get("origin") as string;
  const destinationRow = await resolveTripDestination(supabase, reqs, params.tripId);

  const [outboundRows, returnRows] = await Promise.all([
    getFlightsByIds(supabase, [params.outboundFlightId]),
    getFlightsByIds(supabase, [params.returnFlightId]),
  ]);
  const outboundFlight = outboundRows[0];
  const returnFlight = returnRows[0];
  if (!outboundFlight || !returnFlight) {
    throw new InvalidFlightSelectionError(params.tripId, "one or both flight IDs don't resolve to real inventory.");
  }
  // `origin` (a traveler's home city) is checked by name — it's never a
  // seeded destination row. `destination`/`origin_id` are checked by id,
  // closing the identifier-space gap a plain-string comparison would leave
  // open (docs/IMPLEMENTATION_PLAN.md §5).
  if (outboundFlight.origin !== origin || outboundFlight.destination_id !== destinationRow.id) {
    throw new InvalidFlightSelectionError(
      params.tripId,
      `outbound flight ${outboundFlight.id} (${outboundFlight.origin} -> ${outboundFlight.destination}) doesn't match the trip's route (${origin} -> ${destinationRow.name}).`,
    );
  }
  if (returnFlight.origin_id !== destinationRow.id || returnFlight.destination !== origin) {
    throw new InvalidFlightSelectionError(
      params.tripId,
      `return flight ${returnFlight.id} (${returnFlight.origin} -> ${returnFlight.destination}) doesn't match the trip's return route (${destinationRow.name} -> ${origin}).`,
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

  // Capture the *previous* confirmation's derived stay dates (if any) before
  // superseding it below — needed for the flight->hotel cascade check after
  // persisting the new selection.
  const priorOutboundId = priorDecisions.find((d) => d.field === "outboundFlight" && d.status === "confirmed")?.value as
    | string
    | undefined;
  const priorReturnId = priorDecisions.find((d) => d.field === "returnFlight" && d.status === "confirmed")?.value as
    | string
    | undefined;
  const priorCascadableDecisions = {
    hotel: priorDecisions.find((d) => d.field === "hotel"),
    activities: priorDecisions.find((d) => d.field === "activities"),
  } as const;
  let priorStayDates: HotelStayDates | null = null;
  if (priorOutboundId && priorReturnId) {
    const [priorOutboundRows, priorReturnRows] = await Promise.all([
      getFlightsByIds(supabase, [priorOutboundId]),
      getFlightsByIds(supabase, [priorReturnId]),
    ]);
    if (priorOutboundRows[0] && priorReturnRows[0]) {
      priorStayDates = deriveHotelStayDates(priorOutboundRows[0], priorReturnRows[0]);
    }
  }

  await confirmDecisionField(supabase, params.tripId, "outboundFlight", outboundFlight.id, priorDecisions);
  await confirmDecisionField(supabase, params.tripId, "returnFlight", returnFlight.id, priorDecisions);

  await appendTripEvent(supabase, {
    tripId: params.tripId,
    eventType: "flight_step_confirmed",
    payload: { outboundFlightId: outboundFlight.id, returnFlightId: returnFlight.id } as unknown as Json,
    correlationId: deriveCorrelationId(correlationId, "event:flight_step_confirmed"),
  });

  const newStayDates = deriveHotelStayDates(outboundFlight, returnFlight);
  const datesChanged = priorStayDates !== null && (priorStayDates.checkIn !== newStayDates.checkIn || priorStayDates.checkOut !== newStayDates.checkOut);
  const invalidatedSteps = invalidatedStepsForFlightChange(datesChanged);
  for (const step of ["hotel", "activities"] as const) {
    if (!invalidatedSteps.includes(step)) continue;
    const existing = priorCascadableDecisions[step];
    if (!existing) continue;
    await retireActiveTripDecisionsForField(supabase, params.tripId, step);
    await appendTripEvent(supabase, {
      tripId: params.tripId,
      eventType: `${step}_step_invalidated`,
      payload: {
        reason: "flight_dates_changed",
        previousStayDates: priorStayDates,
        newStayDates,
      } as unknown as Json,
      correlationId: deriveCorrelationId(correlationId, `event:${step}_step_invalidated`),
    });
  }

  return { outboundFlight, returnFlight, hotelStayDates: newStayDates };
}
