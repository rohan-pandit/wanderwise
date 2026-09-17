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
 *    its activities real days/times (`src/domain/scheduling.ts` — the
 *    day-scheduler surfaced as a real gap while wiring this slice: nothing
 *    upstream turns "which activities fit the budget" into "on which day, at
 *    what time") and validates the result end to end
 *    (`validateItineraryFeasibility`, Phase 2; `validateInventoryReferences`,
 *    Phase 2, defense in depth even though every ID here is drawn from an
 *    already-approved set by construction, not model output).
 * 3. Persists the first feasible combination to `trip_decisions` and drives
 *    `combinations_assembled` → `itinerary_valid` (or `itinerary_invalid` if
 *    none of the attempted combinations were feasible), reaching
 *    `presenting_draft`.
 *
 * Deliberately scoped, documented while wiring this slice
 * (`docs/IMPLEMENTATION_PLAN.md` §5): a trip with no stated `returnDate`
 * (one-way — `REQUIRED_FOR_READY` doesn't require it) can't have its hotel
 * stay length or checkout date derived, so this function refuses it rather
 * than guessing (`OneWayTripNotSupportedError`) — full one-way support needs
 * a product decision on default trip length that's out of scope here.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/src/config/supabase/database.types";
import {
  assembleCandidateCombinations,
  type CandidateCombination,
} from "@/src/domain/combinations";
import type { CurationOutput } from "@/src/domain/curation";
import { dateRange, localDateInTimeZone, localMinutesOfDay, nightsBetween } from "@/src/domain/dates";
import type { RequirementFieldName } from "@/src/domain/extraction";
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
import type { MatchedActivity } from "@/src/repositories/activities";
import type { Flight } from "@/src/repositories/flights";
import { recordGuardrailEvent } from "@/src/repositories/guardrail-events";
import type { Hotel } from "@/src/repositories/hotels";
import { appendTripDecision, retireActiveTripDecisionsForField } from "@/src/repositories/trip-decisions";
import { listActiveTripRequirements, type TripRequirementRow } from "@/src/repositories/trip-requirements";
import { getLatestTripState } from "@/src/repositories/trip-state";
import { getOrCreateActiveWorkflowRun } from "@/src/repositories/workflow-runs";
import {
  validateInventoryReferences,
  type ApprovedCandidateSet,
} from "@/src/validation/inventory-references";
import { advanceOrThrow } from "./advance";
import { deriveCorrelationId } from "./correlation";
import { InvalidWorkflowStateError } from "./search-orchestrator";
import type { WorkflowState } from "./state-machine";

export { InvalidWorkflowStateError } from "./search-orchestrator";

const AGENT_NAME = "itinerary_assembly";
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

function requirementMap(rows: TripRequirementRow[]): Map<RequirementFieldName, unknown> {
  const map = new Map<RequirementFieldName, unknown>();
  for (const row of rows) map.set(row.field as RequirementFieldName, row.value);
  return map;
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
  // `returnFlight` is guaranteed non-null here — this function is only ever
  // reached after confirming the trip has a `returnDate` (see
  // `OneWayTripNotSupportedError`), and `assembleCandidateCombinations` only
  // produces a `null` `returnFlight` when no return candidates were given.
  const returnFlight = combination.returnFlight!;
  const destinationTimeZone = outboundFlight.arrival_time_zone ?? "UTC";
  const checkIn = localDateInTimeZone(outboundFlight.arrival_time, destinationTimeZone);
  const checkOut = localDateInTimeZone(returnFlight.departure_time, destinationTimeZone);
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

export interface AssembleItineraryResult {
  workflowState: WorkflowState;
  combination: CandidateCombination<MatchedActivity>;
  draft: DraftItinerary;
  feasibility: FeasibilityResult;
}

export async function assembleItinerary(
  supabase: SupabaseClient<Database>,
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

  let workflowState = await advanceOrThrow(supabase, {
    tripId: params.tripId,
    event: "combinations_assembled",
    actor: AGENT_NAME,
    correlationId: deriveCorrelationId(correlationId, "chain:combinations_assembled"),
    agentName: AGENT_NAME,
    workflowRunId: run.id,
  });

  if (combinations.length === 0) {
    await recordGuardrailEvent(supabase, {
      tripId: params.tripId,
      agentName: AGENT_NAME,
      guardrailName: "itinerary_feasibility",
      layer: "domain_validation",
      triggered: true,
      detail: "no candidate combination fit the budget ceiling at all",
      workflowRunId: run.id,
    });
    await advanceOrThrow(supabase, {
      tripId: params.tripId,
      event: "itinerary_invalid",
      actor: AGENT_NAME,
      correlationId: deriveCorrelationId(correlationId, "chain:itinerary_invalid"),
      agentName: AGENT_NAME,
      workflowRunId: run.id,
    });
    throw new NoFeasibleCombinationError(params.tripId, 0, "no combination fit the budget ceiling");
  }

  let winner: Attempt | null = null;
  let lastAttempt: Attempt | null = null;
  const attemptedCombinations = combinations.slice(0, MAX_COMBINATIONS_TO_TRY);
  for (const combination of attemptedCombinations) {
    const { draft, unscheduledActivityIds } = buildDraft(combination, params.curation);
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
    tripId: params.tripId,
    agentName: AGENT_NAME,
    guardrailName: "itinerary_feasibility",
    layer: "domain_validation",
    triggered: feasibilityTriggered,
    detail: feasibilityTriggered
      ? `${attemptedCombinations.length} combination(s) tried; last attempt had ${lastAttempt!.feasibility.violations.length} violation(s), ${lastAttempt!.unscheduledActivityIds.length} unscheduled activit(y/ies)`
      : null,
    workflowRunId: run.id,
  });

  if (!winner) {
    await advanceOrThrow(supabase, {
      tripId: params.tripId,
      event: "itinerary_invalid",
      actor: AGENT_NAME,
      correlationId: deriveCorrelationId(correlationId, "chain:itinerary_invalid"),
      agentName: AGENT_NAME,
      workflowRunId: run.id,
    });
    throw new NoFeasibleCombinationError(
      params.tripId,
      attemptedCombinations.length,
      lastAttempt!.feasibility.violations.map((v) => v.message).join("; ") || "activities could not all be scheduled",
    );
  }

  const approved: ApprovedCandidateSet<MatchedActivity> = {
    destination,
    inventoryVersion: winner.combination.hotel.inventory_version,
    flights: [...params.outboundFlights, ...params.returnFlights],
    hotels: params.hotels,
    activities: params.activities,
  };
  const referenceCheck = validateInventoryReferences(
    {
      flightIds: [winner.combination.outboundFlight.id, winner.combination.returnFlight!.id],
      hotelIds: [winner.combination.hotel.id],
      activityIds: winner.combination.activities.map((a) => a.id),
    },
    approved,
  );
  await recordGuardrailEvent(supabase, {
    tripId: params.tripId,
    agentName: AGENT_NAME,
    guardrailName: "itinerary_inventory_references",
    layer: "domain_validation",
    triggered: !referenceCheck.valid,
    detail: referenceCheck.valid
      ? null
      : `unresolved: ${referenceCheck.unresolvedIds.join(", ")}; violations: ${referenceCheck.violations.map((v) => v.reason).join("; ")}`,
    workflowRunId: run.id,
  });

  workflowState = await advanceOrThrow(supabase, {
    tripId: params.tripId,
    event: "itinerary_valid",
    actor: AGENT_NAME,
    correlationId: deriveCorrelationId(correlationId, "chain:itinerary_valid"),
    agentName: AGENT_NAME,
    workflowRunId: run.id,
  });

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
  for (const [field, value] of decisions) {
    await retireActiveTripDecisionsForField(supabase, params.tripId, field);
    await appendTripDecision(supabase, { tripId: params.tripId, field, value, source: "system_computed" });
  }

  return { workflowState, combination: winner.combination, draft: winner.draft, feasibility: winner.feasibility };
}
