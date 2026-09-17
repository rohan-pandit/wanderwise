/**
 * The Orchestrator step (PROJECT_BRIEF.md §6.2/§6.3) that picks up where
 * `search-orchestrator.ts` leaves off, once a trip reaches
 * `assembling_options`. Phase 6 continued, slice 2
 * (`docs/IMPLEMENTATION_PLAN.md`):
 *
 * 1. Assembles budget-feasible flight+hotel+activities combinations
 *    (`assembleCandidateCombinations`, Phase 2) from what
 *    `runSearchAndCuration` already found, preferring the Curator's ranked
 *    (non-excluded) activities when curation succeeded.
 * 2. For each candidate combination (best-first, up to a small cap), assigns
 *    its activities real days/times (`src/domain/scheduling.ts`) and
 *    validates the result end to end (`validateItineraryFeasibility`,
 *    `validateInventoryReferences`, both Phase 2).
 * 3. Runs the Itinerary Writer agent (`src/agents/itinerary-writer.ts`,
 *    Phase 7) over the winning combination to produce readable prose.
 * 4. Persists the winner to `trip_decisions` and drives
 *    `combinations_assembled` → `itinerary_valid` (or `itinerary_invalid` if
 *    none of the attempted combinations were feasible), reaching
 *    `presenting_draft`.
 *
 * Also exports `reviseItinerary` (Phase 7) — the *decision*-revision loop
 * `intake-orchestrator.ts` used to log as unsupported before `trip_decisions`
 * existed. It re-fetches alternate candidates for exactly one field
 * (`outboundFlight`/`returnFlight`/`hotel`), excludes the currently-selected
 * one, and reuses the exact same combine → schedule → validate → write →
 * persist pipeline via `finalizeCombinations` below — a revision is
 * structurally just "re-run assembly with one field's candidate pool
 * narrowed," not a different algorithm.
 *
 * Deliberately scoped, documented while wiring this (`docs/IMPLEMENTATION_PLAN.md`
 * §5): a trip with no stated `returnDate` (one-way — `REQUIRED_FOR_READY`
 * doesn't require it) can't have its hotel stay length or checkout date
 * derived, so `assembleItinerary` refuses it rather than guessing
 * (`OneWayTripNotSupportedError`). Revising `activities` (as opposed to
 * `outboundFlight`/`returnFlight`/`hotel`) isn't supported either — which
 * specific activity to swap needs more than a field name to resolve.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/src/config/supabase/database.types";
import { runItineraryWriterAgent } from "@/src/agents/itinerary-writer";
import type { ModelClient } from "@/src/agents/model-client";
import { assembleCandidateCombinations, type CandidateCombination } from "@/src/domain/combinations";
import { filterHardConstraints } from "@/src/domain/constraints";
import type { CurationOutput } from "@/src/domain/curation";
import { dateRange, localMinutesOfDay, nightsBetween } from "@/src/domain/dates";
import {
  DEFAULT_TRANSFER_BUFFER_MINUTES,
  validateItineraryFeasibility,
  type DraftItinerary,
  type FeasibilityResult,
  type OpeningHours,
  type ScheduledActivity,
} from "@/src/domain/feasibility";
import type { RoomGroup } from "@/src/domain/rooms";
import { scheduleActivities } from "@/src/domain/scheduling";
import { deriveHotelStayDates } from "@/src/domain/stay";
import { recordAgentRun, recordToolCalls } from "@/src/repositories/agent-runs";
import { getActivitiesByIds, type MatchedActivity } from "@/src/repositories/activities";
import { findFlights, getFlightsByIds, type Flight } from "@/src/repositories/flights";
import { recordGuardrailEvent } from "@/src/repositories/guardrail-events";
import { findHotels, getHotelsByIds, type Hotel } from "@/src/repositories/hotels";
import { appendTripDecision, listActiveTripDecisions, retireActiveTripDecisionsForField } from "@/src/repositories/trip-decisions";
import { listActiveTripRequirements } from "@/src/repositories/trip-requirements";
import { getLatestTripState } from "@/src/repositories/trip-state";
import { getOrCreateActiveWorkflowRun } from "@/src/repositories/workflow-runs";
import { validateInventoryReferences, type ApprovedCandidateSet } from "@/src/validation/inventory-references";
import { advanceOrThrow } from "./advance";
import { deriveCorrelationId } from "./correlation";
import { flightHardConstraints, hotelHardConstraints, InvalidWorkflowStateError, requirementMap } from "./search-orchestrator";
import type { WorkflowState } from "./state-machine";

export { InvalidWorkflowStateError } from "./search-orchestrator";

const AGENT_NAME = "itinerary_assembly";
const WRITER_AGENT_NAME = "itinerary_writer";
/** How many of the best-ranked combinations to try scheduling/validating before giving up. Bounded — this is retrying against already-computed candidates, not re-searching inventory. */
const MAX_COMBINATIONS_TO_TRY = 5;

export class OneWayTripNotSupportedError extends Error {
  constructor(tripId: string) {
    super(
      `Trip ${tripId} has no returnDate — combination assembly can't derive a hotel-stay length or checkout date for a one-way trip yet.`,
    );
    this.name = "OneWayTripNotSupportedError";
  }
}

/** Thrown after driving the workflow into `itinerary_invalid` (back to `assembling_options`) — a real, resumable outcome, not a bug. */
export class NoFeasibleCombinationError extends Error {
  constructor(tripId: string, attempted: number, lastReason: string) {
    super(
      `Trip ${tripId}: none of the ${attempted} candidate combination(s) tried produced a feasible itinerary. Last attempt: ${lastReason}`,
    );
    this.name = "NoFeasibleCombinationError";
  }
}

export type RevisableDecisionField = "outboundFlight" | "returnFlight" | "hotel";

export class UnsupportedDecisionFieldError extends Error {
  constructor(tripId: string, field: string) {
    super(`Trip ${tripId}: revising "${field}" isn't supported — only outboundFlight/returnFlight/hotel can be revised.`);
    this.name = "UnsupportedDecisionFieldError";
  }
}

function curationRankIndex(curation: CurationOutput | null, id: string): number {
  if (!curation) return 0;
  const index = curation.rankedIds.indexOf(id);
  return index === -1 ? curation.rankedIds.length : index;
}

interface Attempt {
  combination: CandidateCombination<MatchedActivity>;
  draft: DraftItinerary;
  feasibility: FeasibilityResult;
  unscheduledActivityIds: string[];
}

function buildDraft(
  combination: CandidateCombination<MatchedActivity>,
  curation: CurationOutput | null,
): { draft: DraftItinerary; unscheduledActivityIds: string[] } {
  const outboundFlight = combination.outboundFlight;
  // `returnFlight` is guaranteed non-null here — every caller of this
  // function first confirmed the trip has a `returnDate` (see
  // `OneWayTripNotSupportedError`), and `assembleCandidateCombinations` only
  // produces a `null` `returnFlight` when no return candidates were given.
  const returnFlight = combination.returnFlight!;
  const { destinationTimeZone, checkIn, checkOut } = deriveHotelStayDates(outboundFlight, returnFlight);
  const tripDateRange = dateRange(checkIn, checkOut);

  // Schedule in curation-rank order (when available) so higher-ranked
  // activities claim earlier/better slots — `assembleCandidateCombinations`
  // itself picks activities by price, not curation rank, so this ordering
  // only affects placement, not which activities made it into the
  // combination.
  const orderedActivities = [...combination.activities].sort(
    (a, b) => curationRankIndex(curation, a.id) - curationRankIndex(curation, b.id),
  );

  // The scheduler needs to respect the same arrival/departure transfer
  // buffers `validateItineraryFeasibility` checks against — otherwise it
  // would happily place an activity at the default 10:00 start right on the
  // arrival day, which feasibility is guaranteed to reject as scheduled
  // before the landing buffer. Only the check-in/check-out dates get a
  // boundary; every day in between uses the scheduler's own defaults.
  const earliestStartByDate = {
    [checkIn]: localMinutesOfDay(outboundFlight.arrival_time, destinationTimeZone) + DEFAULT_TRANSFER_BUFFER_MINUTES,
  };
  const latestEndByDate = {
    [checkOut]: localMinutesOfDay(returnFlight.departure_time, destinationTimeZone) - DEFAULT_TRANSFER_BUFFER_MINUTES,
  };

  const schedule = scheduleActivities({
    activities: orderedActivities.map((a) => ({
      id: a.id,
      durationMinutes: a.duration_minutes,
      openingHours: a.opening_hours as OpeningHours | null,
      closedDays: a.closed_days,
    })),
    dateRange: tripDateRange,
    earliestStartByDate,
    latestEndByDate,
  });

  const activityById = new Map(orderedActivities.map((a) => [a.id, a]));
  const scheduledActivities: ScheduledActivity[] = schedule.scheduled.map((slot) => {
    const activity = activityById.get(slot.id)!;
    return {
      id: slot.id,
      date: slot.date,
      startMinutes: slot.startMinutes,
      durationMinutes: slot.durationMinutes,
      openingHours: activity.opening_hours as OpeningHours | null,
      closedDays: activity.closed_days,
    };
  });

  const draft: DraftItinerary = {
    destinationTimeZone,
    tripDateRange,
    outboundFlight: {
      id: outboundFlight.id,
      departureTime: outboundFlight.departure_time,
      arrivalTime: outboundFlight.arrival_time,
      departureTimeZone: outboundFlight.departure_time_zone ?? "UTC",
      arrivalTimeZone: destinationTimeZone,
    },
    returnFlight: {
      id: returnFlight.id,
      departureTime: returnFlight.departure_time,
      arrivalTime: returnFlight.arrival_time,
      departureTimeZone: destinationTimeZone,
      arrivalTimeZone: returnFlight.arrival_time_zone ?? "UTC",
    },
    hotelStay: { id: combination.hotel.id, checkIn, checkOut },
    scheduledActivities,
  };

  return { draft, unscheduledActivityIds: schedule.unscheduled };
}

/** Builds the Itinerary Writer's input: one entry per flight/hotel/activity, `id` plus whatever attributes make for a readable write-up. */
function buildWriterSelections(
  combination: CandidateCombination<MatchedActivity>,
  draft: DraftItinerary,
): { id: string; [attribute: string]: unknown }[] {
  const activityById = new Map(combination.activities.map((a) => [a.id, a]));
  return [
    {
      id: combination.outboundFlight.id,
      kind: "outboundFlight",
      airline: combination.outboundFlight.airline,
      flightNumber: combination.outboundFlight.flight_number,
      departureTime: draft.outboundFlight.departureTime,
      arrivalTime: draft.outboundFlight.arrivalTime,
      priceUsd: combination.outboundFlight.price_usd,
    },
    {
      id: combination.returnFlight!.id,
      kind: "returnFlight",
      airline: combination.returnFlight!.airline,
      flightNumber: combination.returnFlight!.flight_number,
      departureTime: draft.returnFlight.departureTime,
      arrivalTime: draft.returnFlight.arrivalTime,
      priceUsd: combination.returnFlight!.price_usd,
    },
    {
      id: combination.hotel.id,
      kind: "hotel",
      name: combination.hotel.name,
      neighborhood: combination.hotel.neighborhood,
      checkIn: draft.hotelStay.checkIn,
      checkOut: draft.hotelStay.checkOut,
      pricePerNightUsd: combination.hotel.price_per_night_usd,
    },
    ...draft.scheduledActivities.map((s) => {
      const activity = activityById.get(s.id);
      return {
        id: s.id,
        kind: "activity",
        name: activity?.name,
        category: activity?.category,
        date: s.date,
        startMinutes: s.startMinutes,
        durationMinutes: s.durationMinutes,
        priceUsd: activity?.price_usd,
      };
    }),
  ];
}

interface FinalizeParams {
  tripId: string;
  correlationId: string;
  runId: string;
  combinations: CandidateCombination<MatchedActivity>[];
  curation: CurationOutput | null;
  approved: ApprovedCandidateSet<MatchedActivity>;
  modelClient: ModelClient;
}

export interface AssembleItineraryResult {
  workflowState: WorkflowState;
  combination: CandidateCombination<MatchedActivity>;
  draft: DraftItinerary;
  feasibility: FeasibilityResult;
  itineraryText: string | null;
}

/**
 * Shared by `assembleItinerary` and `reviseItinerary`: both computed a
 * ranked `combinations` list by this point (from a fresh search or from a
 * narrowed alternate-candidate pool) and both land in `validating_itinerary`
 * — from here on, trying combinations, validating, writing, and persisting
 * is identical regardless of how the workflow got here.
 */
async function finalizeCombinations(
  supabase: SupabaseClient<Database>,
  params: FinalizeParams,
): Promise<AssembleItineraryResult> {
  const { tripId, correlationId, runId, combinations, curation, approved, modelClient } = params;

  if (combinations.length === 0) {
    await recordGuardrailEvent(supabase, {
      tripId,
      agentName: AGENT_NAME,
      guardrailName: "itinerary_feasibility",
      layer: "domain_validation",
      triggered: true,
      detail: "no candidate combination fit the budget ceiling at all",
      workflowRunId: runId,
    });
    await advanceOrThrow(supabase, {
      tripId,
      event: "itinerary_invalid",
      actor: AGENT_NAME,
      correlationId: deriveCorrelationId(correlationId, "chain:itinerary_invalid"),
      agentName: AGENT_NAME,
      workflowRunId: runId,
    });
    throw new NoFeasibleCombinationError(tripId, 0, "no combination fit the budget ceiling");
  }

  let winner: Attempt | null = null;
  let lastAttempt: Attempt | null = null;
  const attemptedCombinations = combinations.slice(0, MAX_COMBINATIONS_TO_TRY);
  for (const combination of attemptedCombinations) {
    const { draft, unscheduledActivityIds } = buildDraft(combination, curation);
    const feasibility = validateItineraryFeasibility(draft);
    const attempt: Attempt = { combination, draft, feasibility, unscheduledActivityIds };
    lastAttempt = attempt;
    if (feasibility.valid && unscheduledActivityIds.length === 0) {
      winner = attempt;
      break;
    }
  }

  const feasibilityTriggered = winner === null;
  await recordGuardrailEvent(supabase, {
    tripId,
    agentName: AGENT_NAME,
    guardrailName: "itinerary_feasibility",
    layer: "domain_validation",
    triggered: feasibilityTriggered,
    detail: feasibilityTriggered
      ? `${attemptedCombinations.length} combination(s) tried; last attempt had ${lastAttempt!.feasibility.violations.length} violation(s), ${lastAttempt!.unscheduledActivityIds.length} unscheduled activit(y/ies)`
      : null,
    workflowRunId: runId,
  });

  if (!winner) {
    await advanceOrThrow(supabase, {
      tripId,
      event: "itinerary_invalid",
      actor: AGENT_NAME,
      correlationId: deriveCorrelationId(correlationId, "chain:itinerary_invalid"),
      agentName: AGENT_NAME,
      workflowRunId: runId,
    });
    throw new NoFeasibleCombinationError(
      tripId,
      attemptedCombinations.length,
      lastAttempt!.feasibility.violations.map((v) => v.message).join("; ") || "activities could not all be scheduled",
    );
  }

  const referenceCheck = validateInventoryReferences(
    {
      flightIds: [winner.combination.outboundFlight.id, winner.combination.returnFlight!.id],
      hotelIds: [winner.combination.hotel.id],
      activityIds: winner.combination.activities.map((a) => a.id),
    },
    approved,
  );
  await recordGuardrailEvent(supabase, {
    tripId,
    agentName: AGENT_NAME,
    guardrailName: "itinerary_inventory_references",
    layer: "domain_validation",
    triggered: !referenceCheck.valid,
    detail: referenceCheck.valid
      ? null
      : `unresolved: ${referenceCheck.unresolvedIds.join(", ")}; violations: ${referenceCheck.violations.map((v) => v.reason).join("; ")}`,
    workflowRunId: runId,
  });

  const workflowState = await advanceOrThrow(supabase, {
    tripId,
    event: "itinerary_valid",
    actor: AGENT_NAME,
    correlationId: deriveCorrelationId(correlationId, "chain:itinerary_valid"),
    agentName: AGENT_NAME,
    workflowRunId: runId,
  });

  // The Itinerary Writer runs after the itinerary is already known-valid —
  // prose is a presentation concern layered on top of the deterministic
  // decision, not part of deciding whether the decision is valid. A writer
  // failure (API error, ungrounded output) is non-fatal: the deterministic
  // data is still enough to present a draft, so it's logged and skipped
  // rather than blocking the workflow transition that already happened.
  const startedAt = Date.now();
  let itineraryText: string | null = null;
  try {
    const writerResult = await runItineraryWriterAgent(modelClient, {
      selections: buildWriterSelections(winner.combination, winner.draft),
    });
    const incompleteStopReason = writerResult.stopReason !== "end_turn" && writerResult.stopReason !== "tool_use";
    const agentRun = await recordAgentRun(supabase, {
      tripId,
      workflowRunId: runId,
      agentName: WRITER_AGENT_NAME,
      model: modelClient.model,
      usage: writerResult.usage,
      latencyMs: Date.now() - startedAt,
      status: writerResult.itinerary && !incompleteStopReason ? "success" : "error",
      errorMessage: incompleteStopReason
        ? `stop_reason: ${writerResult.stopReason}`
        : writerResult.itinerary
          ? null
          : "no valid write_itinerary call",
      correlationId,
    });
    await recordToolCalls(
      supabase,
      agentRun.id,
      writerResult.toolCallLog.map((call) => ({
        toolName: call.toolName,
        arguments: call.input as Json,
        result: (call.result ?? null) as Json,
        status: call.status,
      })),
    );
    await recordGuardrailEvent(supabase, {
      tripId,
      agentName: WRITER_AGENT_NAME,
      guardrailName: "itinerary_writer_grounding",
      layer: "domain_validation",
      triggered: writerResult.referenceCheck !== null && !writerResult.referenceCheck.valid,
      detail:
        writerResult.referenceCheck && !writerResult.referenceCheck.valid
          ? `unresolved ids: ${writerResult.referenceCheck.unresolvedIds.join(", ")}`
          : null,
      workflowRunId: runId,
    });
    itineraryText = writerResult.itinerary?.explanation ?? null;
  } catch (err) {
    await recordAgentRun(supabase, {
      tripId,
      workflowRunId: runId,
      agentName: WRITER_AGENT_NAME,
      model: modelClient.model,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      latencyMs: Date.now() - startedAt,
      status: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      correlationId,
    });
  }

  const decisions: [string, Json][] = [
    ["outboundFlight", winner.combination.outboundFlight.id],
    ["returnFlight", winner.combination.returnFlight!.id],
    ["hotel", winner.combination.hotel.id],
    [
      "activities",
      winner.draft.scheduledActivities.map((a) => ({
        id: a.id,
        date: a.date,
        startMinutes: a.startMinutes,
        durationMinutes: a.durationMinutes,
      })),
    ],
    ["budget", winner.combination.budget as unknown as Json],
  ];
  if (itineraryText) decisions.push(["itineraryText", itineraryText]);

  for (const [field, value] of decisions) {
    await retireActiveTripDecisionsForField(supabase, tripId, field);
    await appendTripDecision(supabase, { tripId, field, value, source: "system_computed" });
  }

  return { workflowState, combination: winner.combination, draft: winner.draft, feasibility: winner.feasibility, itineraryText };
}

export interface AssembleItineraryParams {
  tripId: string;
  /** Idempotency key — see `deriveCorrelationId`. Defaults to a fresh UUID if omitted. */
  correlationId?: string;
  outboundFlights: Flight[];
  returnFlights: Flight[];
  hotels: Hotel[];
  /** The activity candidates `runSearchAndCuration` returned. */
  activities: MatchedActivity[];
  curation: CurationOutput | null;
}

export async function assembleItinerary(
  supabase: SupabaseClient<Database>,
  modelClient: ModelClient,
  params: AssembleItineraryParams,
): Promise<AssembleItineraryResult> {
  const correlationId = params.correlationId ?? randomUUID();

  const currentState = await getLatestTripState(supabase, params.tripId);
  if (!currentState) {
    throw new Error(`Trip ${params.tripId} has no state history — call startTrip first.`);
  }
  if (currentState.state.workflowState !== "assembling_options") {
    throw new InvalidWorkflowStateError(params.tripId, currentState.state.workflowState, "assembling_options");
  }

  const [requirementRows, run] = await Promise.all([
    listActiveTripRequirements(supabase, params.tripId),
    getOrCreateActiveWorkflowRun(supabase, params.tripId),
  ]);
  const reqs = requirementMap(requirementRows);

  const destination = reqs.get("destination") as string;
  const departureDate = reqs.get("departureDate") as string;
  const returnDate = reqs.get("returnDate") as string | undefined;
  if (!returnDate) {
    throw new OneWayTripNotSupportedError(params.tripId);
  }
  const partySize = reqs.get("partySize") as number;
  const roomGroups = (reqs.get("roomGroups") as RoomGroup[] | undefined) ?? [{ occupants: partySize }];
  const budgetTotalUsd = reqs.get("budgetTotalUsd") as number;
  const nights = nightsBetween(dateRange(departureDate, returnDate));

  const candidateActivities = params.curation
    ? params.activities.filter((a) => params.curation!.rankedIds.includes(a.id))
    : params.activities;

  const combinations = assembleCandidateCombinations<MatchedActivity>({
    outboundFlights: params.outboundFlights,
    returnFlights: params.returnFlights,
    hotels: params.hotels,
    activities: candidateActivities,
    travelers: partySize,
    roomGroups,
    nights,
    targetUsd: budgetTotalUsd,
  });

  await advanceOrThrow(supabase, {
    tripId: params.tripId,
    event: "combinations_assembled",
    actor: AGENT_NAME,
    correlationId: deriveCorrelationId(correlationId, "chain:combinations_assembled"),
    agentName: AGENT_NAME,
    workflowRunId: run.id,
  });

  const approved: ApprovedCandidateSet<MatchedActivity> = {
    destination,
    inventoryVersion: params.hotels[0]?.inventory_version ?? 1,
    flights: [...params.outboundFlights, ...params.returnFlights],
    hotels: params.hotels,
    activities: params.activities,
  };

  return finalizeCombinations(supabase, {
    tripId: params.tripId,
    correlationId,
    runId: run.id,
    combinations,
    curation: params.curation,
    approved,
    modelClient,
  });
}

export interface ReviseItineraryParams {
  tripId: string;
  /** Idempotency key — see `deriveCorrelationId`. Defaults to a fresh UUID if omitted. */
  correlationId?: string;
  field: RevisableDecisionField;
}

function decisionValueMap(rows: { field: string; value: Json }[]): Map<string, Json> {
  const map = new Map<string, Json>();
  for (const row of rows) map.set(row.field, row.value);
  return map;
}

/**
 * Applies a decision revision (Phase 7): re-fetches alternate candidates for
 * exactly one field, excludes the currently-selected one, and re-runs the
 * combine → schedule → validate → write → persist pipeline
 * (`finalizeCombinations`) with everything else held fixed to the trip's
 * current selections. If no alternate candidate passes hard constraints,
 * the current selection is kept as-is (logged as a guardrail, not an
 * error) — the revision request itself isn't a bug, there's just nothing
 * else to switch to.
 */
export async function reviseItinerary(
  supabase: SupabaseClient<Database>,
  modelClient: ModelClient,
  params: ReviseItineraryParams,
): Promise<AssembleItineraryResult> {
  const correlationId = params.correlationId ?? randomUUID();

  const currentState = await getLatestTripState(supabase, params.tripId);
  if (!currentState) {
    throw new Error(`Trip ${params.tripId} has no state history — call startTrip first.`);
  }
  const fromState = currentState.state.workflowState;
  if (fromState !== "presenting_draft" && fromState !== "awaiting_confirmation") {
    throw new InvalidWorkflowStateError(params.tripId, fromState, "presenting_draft");
  }

  const [requirementRows, decisionRows, run] = await Promise.all([
    listActiveTripRequirements(supabase, params.tripId),
    listActiveTripDecisions(supabase, params.tripId),
    getOrCreateActiveWorkflowRun(supabase, params.tripId),
  ]);
  const reqs = requirementMap(requirementRows);
  const decisions = decisionValueMap(decisionRows);

  const origin = reqs.get("origin") as string;
  const destination = reqs.get("destination") as string;
  const departureDate = reqs.get("departureDate") as string;
  const returnDate = reqs.get("returnDate") as string;
  const partySize = reqs.get("partySize") as number;
  const roomGroups = (reqs.get("roomGroups") as RoomGroup[] | undefined) ?? [{ occupants: partySize }];
  const budgetTotalUsd = reqs.get("budgetTotalUsd") as number;
  const nights = nightsBetween(dateRange(departureDate, returnDate));

  const currentOutboundId = decisions.get("outboundFlight") as string;
  const currentReturnId = decisions.get("returnFlight") as string;
  const currentHotelId = decisions.get("hotel") as string;
  const currentActivitySchedule =
    (decisions.get("activities") as { id: string }[] | undefined) ?? [];

  const [currentOutboundRows, currentReturnRows, currentHotelRows, currentActivities] = await Promise.all([
    getFlightsByIds(supabase, [currentOutboundId]),
    getFlightsByIds(supabase, [currentReturnId]),
    getHotelsByIds(supabase, [currentHotelId]),
    getActivitiesByIds(supabase, currentActivitySchedule.map((a) => a.id)),
  ]);
  const currentOutbound = currentOutboundRows[0];
  const currentReturn = currentReturnRows[0];
  const currentHotel = currentHotelRows[0];
  if (!currentOutbound || !currentReturn || !currentHotel) {
    throw new Error(`Trip ${params.tripId}: current decision rows reference missing inventory — can't revise.`);
  }

  let outboundCandidates = [currentOutbound];
  let returnCandidates = [currentReturn];
  let hotelCandidates = [currentHotel];
  let noAlternativeFound = false;

  if (params.field === "outboundFlight") {
    const fetched = await findFlights(supabase, {
      origin,
      destination,
      departureDate,
      maxPriceUsd: reqs.get("maxFlightPriceUsd") as number | undefined,
      excludeRedEye: reqs.get("noRedEye") === true,
    });
    const passing = filterHardConstraints(fetched, flightHardConstraints(reqs)).passing.filter(
      (f) => f.id !== currentOutboundId,
    );
    if (passing.length > 0) outboundCandidates = passing;
    else noAlternativeFound = true;
  } else if (params.field === "returnFlight") {
    const fetched = await findFlights(supabase, {
      origin: destination,
      destination: origin,
      departureDate: returnDate,
      maxPriceUsd: reqs.get("maxFlightPriceUsd") as number | undefined,
      excludeRedEye: reqs.get("noRedEye") === true,
    });
    const passing = filterHardConstraints(fetched, flightHardConstraints(reqs)).passing.filter(
      (f) => f.id !== currentReturnId,
    );
    if (passing.length > 0) returnCandidates = passing;
    else noAlternativeFound = true;
  } else if (params.field === "hotel") {
    const fetched = await findHotels(supabase, {
      destination,
      minRating: reqs.get("minHotelRating") as number | undefined,
    });
    const passing = filterHardConstraints(fetched, hotelHardConstraints(reqs, roomGroups)).passing.filter(
      (h) => h.id !== currentHotelId,
    );
    if (passing.length > 0) hotelCandidates = passing;
    else noAlternativeFound = true;
  } else {
    throw new UnsupportedDecisionFieldError(params.tripId, params.field);
  }

  await advanceOrThrow(supabase, {
    tripId: params.tripId,
    event: "revision_requested",
    actor: AGENT_NAME,
    correlationId: deriveCorrelationId(correlationId, "chain:revision_requested"),
    agentName: AGENT_NAME,
    workflowRunId: run.id,
  });
  await advanceOrThrow(supabase, {
    tripId: params.tripId,
    event: "revision_submitted",
    actor: AGENT_NAME,
    correlationId: deriveCorrelationId(correlationId, "chain:revision_submitted"),
    agentName: AGENT_NAME,
    workflowRunId: run.id,
  });

  if (noAlternativeFound) {
    await recordGuardrailEvent(supabase, {
      tripId: params.tripId,
      agentName: AGENT_NAME,
      guardrailName: "revision_no_alternative",
      layer: "domain_validation",
      triggered: true,
      detail: `No alternative ${params.field} candidate passed hard constraints — kept the current selection.`,
      workflowRunId: run.id,
    });
  }

  await advanceOrThrow(supabase, {
    tripId: params.tripId,
    event: "revision_applied",
    actor: AGENT_NAME,
    correlationId: deriveCorrelationId(correlationId, "chain:revision_applied"),
    agentName: AGENT_NAME,
    workflowRunId: run.id,
  });

  const combinations = assembleCandidateCombinations<MatchedActivity>({
    outboundFlights: outboundCandidates,
    returnFlights: returnCandidates,
    hotels: hotelCandidates,
    activities: currentActivities,
    travelers: partySize,
    roomGroups,
    nights,
    targetUsd: budgetTotalUsd,
  });

  const approved: ApprovedCandidateSet<MatchedActivity> = {
    destination,
    inventoryVersion: currentHotel.inventory_version,
    flights: [...outboundCandidates, ...returnCandidates],
    hotels: hotelCandidates,
    activities: currentActivities,
  };

  return finalizeCombinations(supabase, {
    tripId: params.tripId,
    correlationId,
    runId: run.id,
    combinations,
    curation: null,
    approved,
    modelClient,
  });
}
