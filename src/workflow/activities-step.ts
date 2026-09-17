/**
 * The activities step of the stepwise chain redesign
 * (`docs/IMPLEMENTATION_PLAN.md`'s "STEPWISE CHAIN REDESIGN" section,
 * decided 2026-09-17) — slice 3, the last step in the chain. Reuses the
 * Phase 2/5/7 domain logic the old one-shot pipeline (`itinerary-orchestrator.ts`,
 * retired this slice) already established for retrieval, scheduling,
 * feasibility, budget, and the Itinerary Writer — the seam that changed is
 * *when* it runs (per-step, against an already-confirmed flight+hotel) and
 * *what* it's invoked against (a single hotel/flight pair, not a
 * cross-joined combination search), not the underlying algorithms.
 *
 * Like the flight/hotel steps, this can only propose once the step before
 * it (hotel) is confirmed, since scheduling needs the confirmed flight's
 * derived stay dates (`src/domain/stay.ts`) and transfer buffers. Unlike
 * flight/hotel, `proposeActivitiesStep` doesn't return a short list of
 * interchangeable single picks — activities are a scheduling problem, not a
 * pick-one problem, so it returns the one curated+scheduled result. Since
 * this is the *last* chain step (design rule 4 — nothing further
 * downstream), `confirmActivitiesStep` is also where the trip's budget gets
 * computed and the Itinerary Writer runs, exactly as the old pipeline's
 * `finalizeCombinations` did at the end of its one-shot assembly.
 *
 * Slice 4: `proposeActivitiesStep` persists its one scheduled result as a
 * `"proposed"` `trip_decisions` row (same reasoning as flight/hotel — reload
 * survival for a real UI). `confirmActivitiesStep` needs no equivalent
 * change: its existing retire-then-insert-as-confirmed loop over
 * `activities`/`budget`/`itineraryText` already correctly supersedes that
 * proposed row in the same call that writes the confirmed one.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/src/config/supabase/database.types";
import { runCuratorAgent } from "@/src/agents/curator";
import { runItineraryWriterAgent } from "@/src/agents/itinerary-writer";
import type { ModelClient } from "@/src/agents/model-client";
import { calculateBudget, type BudgetBreakdown } from "@/src/domain/budget";
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
import { scheduleActivities, type PreferredWindow } from "@/src/domain/scheduling";
import { deriveHotelStayDates } from "@/src/domain/stay";
import { estimateCostUsd } from "@/src/observability/pricing";
import { recordAgentRun, recordToolCalls } from "@/src/repositories/agent-runs";
import { getActivitiesByIds, type MatchedActivity } from "@/src/repositories/activities";
import { getFlightsByIds, type Flight } from "@/src/repositories/flights";
import { recordGuardrailEvent } from "@/src/repositories/guardrail-events";
import { getHotelsByIds, type Hotel } from "@/src/repositories/hotels";
import {
  appendTripDecision,
  listActiveTripDecisions,
  retireActiveTripDecisionsForField,
  retireProposedTripDecisionsForField,
} from "@/src/repositories/trip-decisions";
import { appendTripEvent } from "@/src/repositories/trip-events";
import { listActiveTripPreferences } from "@/src/repositories/trip-preferences";
import { listActiveTripRequirements } from "@/src/repositories/trip-requirements";
import { getOrCreateActiveWorkflowRun } from "@/src/repositories/workflow-runs";
import type { EmbeddingClient } from "@/src/retrieval/embedding-client";
import { retrieveActivities } from "@/src/retrieval/activities-retrieval";
import { deriveCorrelationId } from "./correlation";
import { FlightStepNotConfirmedError } from "./hotel-step";
import { requirementMap, resolveTripDestination } from "./step-shared";

const AGENT_NAME = "activities_step";
const CURATOR_AGENT_NAME = "destination_and_activity_curator";
const WRITER_AGENT_NAME = "itinerary_writer";
const ACTIVITY_TOP_K = 10;

/**
 * Meal-time bias for `category: "food"` activities (`src/domain/scheduling.ts`'s
 * `preferredWindows`, docs/IMPLEMENTATION_PLAN.md §5 — the "lightweight
 * heuristics on top of the same first-fit structure" option, chosen over a
 * heavier repair pass or real optimizer). Tried in this order — lunch before
 * dinner — across the whole date range before the scheduler falls back to
 * placing the activity anywhere it fits.
 */
const LUNCH_WINDOW: PreferredWindow = { startMinutes: 11 * 60 + 30, endMinutes: 14 * 60 };
const DINNER_WINDOW: PreferredWindow = { startMinutes: 18 * 60, endMinutes: 21 * 60 };
const MEAL_WINDOWS: PreferredWindow[] = [LUNCH_WINDOW, DINNER_WINDOW];

export { FlightStepNotConfirmedError } from "./hotel-step";

export class HotelStepNotConfirmedError extends Error {
  constructor(tripId: string) {
    super(`Trip ${tripId}: the hotel step must be confirmed before the activities step can be proposed.`);
    this.name = "HotelStepNotConfirmedError";
  }
}

export class InvalidActivitiesSelectionError extends Error {
  constructor(tripId: string, detail: string) {
    super(`Trip ${tripId}: invalid activities selection — ${detail}`);
    this.name = "InvalidActivitiesSelectionError";
  }
}

function confirmedDecisionValue(decisions: { field: string; status: string; value: Json }[], field: string): string | undefined {
  return decisions.find((d) => d.field === field && d.status === "confirmed")?.value as string | undefined;
}

interface ConfirmedContext {
  outboundFlight: Flight;
  returnFlight: Flight;
  hotel: Hotel;
  destinationTimeZone: string;
  checkIn: string;
  checkOut: string;
}

/** Loads and validates the flight+hotel confirmations this step depends on — both must already be confirmed. */
async function loadConfirmedContext(supabase: SupabaseClient<Database>, tripId: string): Promise<ConfirmedContext> {
  const decisions = await listActiveTripDecisions(supabase, tripId);
  const outboundId = confirmedDecisionValue(decisions, "outboundFlight");
  const returnId = confirmedDecisionValue(decisions, "returnFlight");
  if (!outboundId || !returnId) {
    throw new FlightStepNotConfirmedError(tripId);
  }
  const hotelId = confirmedDecisionValue(decisions, "hotel");
  if (!hotelId) {
    throw new HotelStepNotConfirmedError(tripId);
  }

  const [outboundRows, returnRows, hotelRows] = await Promise.all([
    getFlightsByIds(supabase, [outboundId]),
    getFlightsByIds(supabase, [returnId]),
    getHotelsByIds(supabase, [hotelId]),
  ]);
  const outboundFlight = outboundRows[0];
  const returnFlight = returnRows[0];
  const hotel = hotelRows[0];
  if (!outboundFlight || !returnFlight || !hotel) {
    throw new Error(`Trip ${tripId}: confirmed flight/hotel decisions reference missing inventory.`);
  }

  const { destinationTimeZone, checkIn, checkOut } = deriveHotelStayDates(outboundFlight, returnFlight);
  return { outboundFlight, returnFlight, hotel, destinationTimeZone, checkIn, checkOut };
}

function curationRankIndex(curation: CurationOutput | null, id: string): number {
  if (!curation) return 0;
  const index = curation.rankedIds.indexOf(id);
  return index === -1 ? curation.rankedIds.length : index;
}

function buildDraft(ctx: ConfirmedContext, scheduledActivities: ScheduledActivity[]): DraftItinerary {
  const { outboundFlight, returnFlight, hotel, destinationTimeZone, checkIn, checkOut } = ctx;
  return {
    destinationTimeZone,
    tripDateRange: dateRange(checkIn, checkOut),
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
    hotelStay: { id: hotel.id, checkIn, checkOut },
    scheduledActivities,
  };
}

/** Builds the Itinerary Writer's input: one entry per flight/hotel/activity, `id` plus whatever attributes make for a readable write-up. Mirrors the old pipeline's `buildWriterSelections` exactly. */
function buildWriterSelections(
  ctx: ConfirmedContext,
  scheduledActivities: ScheduledActivity[],
  activityById: Map<string, MatchedActivity>,
): { id: string; [attribute: string]: unknown }[] {
  const { outboundFlight, returnFlight, hotel, checkIn, checkOut } = ctx;
  return [
    {
      id: outboundFlight.id,
      kind: "outboundFlight",
      airline: outboundFlight.airline,
      flightNumber: outboundFlight.flight_number,
      departureTime: outboundFlight.departure_time,
      arrivalTime: outboundFlight.arrival_time,
      priceUsd: outboundFlight.price_usd,
    },
    {
      id: returnFlight.id,
      kind: "returnFlight",
      airline: returnFlight.airline,
      flightNumber: returnFlight.flight_number,
      departureTime: returnFlight.departure_time,
      arrivalTime: returnFlight.arrival_time,
      priceUsd: returnFlight.price_usd,
    },
    {
      id: hotel.id,
      kind: "hotel",
      name: hotel.name,
      neighborhood: hotel.neighborhood,
      checkIn,
      checkOut,
      pricePerNightUsd: hotel.price_per_night_usd,
    },
    ...scheduledActivities.map((s) => {
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

export interface ProposeActivitiesStepParams {
  tripId: string;
  /** Idempotency key for the logged `trip_events` row — see `deriveCorrelationId`. Defaults to a fresh UUID if omitted. */
  correlationId?: string;
}

export interface ProposedScheduledActivity {
  id: string;
  date: string;
  startMinutes: number;
  durationMinutes: number;
}

export interface ProposeActivitiesStepResult {
  scheduledActivities: ProposedScheduledActivity[];
  /** Curated-but-retrieved candidates that didn't fit any open slot — not an error, just not schedulable this trip. */
  unscheduledActivityIds: string[];
  feasibility: FeasibilityResult;
  /** Null if there were no activity candidates to curate, or the agent's call didn't validate. */
  curation: CurationOutput | null;
}

/**
 * Retrieves activity candidates, curates them against stated preferences
 * (Curator agent), schedules the curated set into the confirmed flight's
 * derived stay dates, and validates feasibility. Nothing is persisted —
 * ephemeral, same pattern the flight/hotel steps use.
 */
export async function proposeActivitiesStep(
  supabase: SupabaseClient<Database>,
  modelClient: ModelClient,
  embeddingClient: EmbeddingClient,
  params: ProposeActivitiesStepParams,
): Promise<ProposeActivitiesStepResult> {
  const correlationId = params.correlationId ?? randomUUID();

  const ctx = await loadConfirmedContext(supabase, params.tripId);

  const [requirementRows, preferenceRows, run] = await Promise.all([
    listActiveTripRequirements(supabase, params.tripId),
    listActiveTripPreferences(supabase, params.tripId),
    getOrCreateActiveWorkflowRun(supabase, params.tripId),
  ]);
  const reqs = requirementMap(requirementRows);
  const destinationRow = await resolveTripDestination(supabase, reqs, params.tripId);

  const preferenceQuery =
    preferenceRows
      .flatMap((p) => (typeof p.value === "string" ? [p.value] : Array.isArray(p.value) ? p.value.filter((v): v is string => typeof v === "string") : []))
      .join(", ") || undefined;

  const candidateActivities = await retrieveActivities(supabase, embeddingClient, {
    destination: destinationRow.name,
    destinationId: destinationRow.id,
    query: preferenceQuery,
    excludeClosedOnDays: reqs.get("excludeClosedOnDays") as string[] | undefined,
    accessibilityNeeds: reqs.get("requiredAccessibility") as string[] | undefined,
    maxPriceUsd: reqs.get("maxActivityPriceUsd") as number | undefined,
    topK: ACTIVITY_TOP_K,
  });

  let curation: CurationOutput | null = null;
  if (candidateActivities.length > 0) {
    const startedAt = Date.now();
    const curatorResult = await runCuratorAgent(modelClient, {
      kind: "activity",
      preferences: preferenceRows.map((p) => ({ field: p.field, value: p.value })),
      candidates: candidateActivities,
    });
    const latencyMs = Date.now() - startedAt;
    const incompleteStopReason = curatorResult.stopReason !== "end_turn" && curatorResult.stopReason !== "tool_use";
    const agentRun = await recordAgentRun(supabase, {
      tripId: params.tripId,
      workflowRunId: run.id,
      agentName: CURATOR_AGENT_NAME,
      model: modelClient.model,
      usage: curatorResult.usage,
      latencyMs,
      costUsd: estimateCostUsd(modelClient.model, curatorResult.usage),
      status: curatorResult.curation && !incompleteStopReason ? "success" : "error",
      errorMessage: incompleteStopReason
        ? `stop_reason: ${curatorResult.stopReason}`
        : curatorResult.curation
          ? null
          : "no valid record_curation call",
      correlationId,
    });
    await recordToolCalls(
      supabase,
      agentRun.id,
      curatorResult.toolCallLog.map((call) => ({
        toolName: call.toolName,
        arguments: call.input as Json,
        result: (call.result ?? null) as Json,
        status: call.status,
      })),
    );
    await recordGuardrailEvent(supabase, {
      tripId: params.tripId,
      agentName: CURATOR_AGENT_NAME,
      guardrailName: "curation_reference_check",
      layer: "domain_validation",
      triggered: curatorResult.referenceCheck !== null && !curatorResult.referenceCheck.valid,
      detail:
        curatorResult.referenceCheck && !curatorResult.referenceCheck.valid
          ? `unresolved ids: ${curatorResult.referenceCheck.unresolvedIds.join(", ")}`
          : null,
      workflowRunId: run.id,
    });
    // Layer 2 guardrail: a malformed tool call (unknown tool, duplicate call,
    // schema failure) is an output-validation trigger, same as Intake's.
    // Excludes "reference_check_failed" entries — those are well-formed calls
    // already logged above as the domain_validation `curation_reference_check`
    // event, so counting them here too would double-count one failure under
    // two layers.
    await Promise.all(
      curatorResult.toolCallLog
        .filter((call) => call.status === "error" && call.errorKind === "malformed")
        .map((call) =>
          recordGuardrailEvent(supabase, {
            tripId: params.tripId,
            agentName: CURATOR_AGENT_NAME,
            guardrailName: "tool_call_schema_validation",
            layer: "output_validation",
            triggered: true,
            detail: `${call.toolName}: ${call.error}`,
            workflowRunId: run.id,
          }),
        ),
    );
    curation = curatorResult.curation;
  }

  const includedActivities = curation ? candidateActivities.filter((a) => curation!.rankedIds.includes(a.id)) : candidateActivities;
  const orderedActivities = curation
    ? [...includedActivities].sort((a, b) => curationRankIndex(curation, a.id) - curationRankIndex(curation, b.id))
    : includedActivities;

  const earliestStartByDate = {
    [ctx.checkIn]: localMinutesOfDay(ctx.outboundFlight.arrival_time, ctx.destinationTimeZone) + DEFAULT_TRANSFER_BUFFER_MINUTES,
  };
  const latestEndByDate = {
    [ctx.checkOut]: localMinutesOfDay(ctx.returnFlight.departure_time, ctx.destinationTimeZone) - DEFAULT_TRANSFER_BUFFER_MINUTES,
  };
  const schedule = scheduleActivities({
    activities: orderedActivities.map((a) => ({
      id: a.id,
      durationMinutes: a.duration_minutes,
      openingHours: a.opening_hours as OpeningHours | null,
      closedDays: a.closed_days,
      preferredWindows: a.category === "food" ? MEAL_WINDOWS : undefined,
    })),
    dateRange: dateRange(ctx.checkIn, ctx.checkOut),
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

  const draft = buildDraft(ctx, scheduledActivities);
  const feasibility = validateItineraryFeasibility(draft);

  await recordGuardrailEvent(supabase, {
    tripId: params.tripId,
    agentName: AGENT_NAME,
    guardrailName: "itinerary_feasibility",
    layer: "domain_validation",
    triggered: !feasibility.valid,
    detail: feasibility.valid ? null : feasibility.violations.map((v) => v.message).join("; "),
    workflowRunId: run.id,
  });

  const proposedScheduledActivities: ProposedScheduledActivity[] = scheduledActivities.map((a) => ({
    id: a.id,
    date: a.date,
    startMinutes: a.startMinutes,
    durationMinutes: a.durationMinutes,
  }));

  // Persisted as "proposed" (stepwise chain redesign slice 4) so the UI can
  // render this schedule and survive a page reload before it's confirmed —
  // a single row, since activities is a scheduling result, not a pick-list.
  await retireProposedTripDecisionsForField(supabase, params.tripId, "activities");
  await appendTripDecision(supabase, {
    tripId: params.tripId,
    field: "activities",
    value: proposedScheduledActivities as unknown as Json,
    source: "system_computed",
    status: "proposed",
  });

  await appendTripEvent(supabase, {
    tripId: params.tripId,
    eventType: "activities_step_proposed",
    payload: {
      scheduledActivityIds: scheduledActivities.map((a) => a.id),
      unscheduledActivityIds: schedule.unscheduled,
    } as unknown as Json,
    correlationId: deriveCorrelationId(correlationId, "event:activities_step_proposed"),
  });

  return {
    scheduledActivities: proposedScheduledActivities,
    unscheduledActivityIds: schedule.unscheduled,
    feasibility,
    curation,
  };
}

export interface ConfirmActivitiesStepParams {
  tripId: string;
  scheduledActivities: ProposedScheduledActivity[];
  /** Idempotency key for the logged `trip_events` row — see `deriveCorrelationId`. Defaults to a fresh UUID if omitted. */
  correlationId?: string;
}

export interface ConfirmActivitiesStepResult {
  scheduledActivities: ProposedScheduledActivity[];
  budget: BudgetBreakdown;
  itineraryText: string | null;
}

/**
 * Persists the confirmed activity schedule. Re-fetches and re-validates the
 * given IDs (defense in depth, same as `confirmFlightStep`/`confirmHotelStep`)
 * and re-runs `validateItineraryFeasibility` against the current confirmed
 * flight/hotel before persisting anything, rather than trusting a `propose`
 * result computed moments earlier is still accurate. Since this is the
 * chain's last step, this is also where the budget gets computed and the
 * Itinerary Writer runs — the `presenting_draft`-equivalent moment for the
 * new model.
 */
export async function confirmActivitiesStep(
  supabase: SupabaseClient<Database>,
  modelClient: ModelClient,
  params: ConfirmActivitiesStepParams,
): Promise<ConfirmActivitiesStepResult> {
  const correlationId = params.correlationId ?? randomUUID();

  const ctx = await loadConfirmedContext(supabase, params.tripId);

  const activityIds = params.scheduledActivities.map((a) => a.id);
  const [activityRows, requirementRows, run] = await Promise.all([
    getActivitiesByIds(supabase, activityIds),
    listActiveTripRequirements(supabase, params.tripId),
    getOrCreateActiveWorkflowRun(supabase, params.tripId),
  ]);
  const activityById = new Map(activityRows.map((a) => [a.id, a]));
  const unresolved = activityIds.filter((id) => !activityById.has(id));
  if (unresolved.length > 0) {
    throw new InvalidActivitiesSelectionError(params.tripId, `unresolved activity id(s): ${unresolved.join(", ")}`);
  }

  const reqs = requirementMap(requirementRows);
  const destinationRow = await resolveTripDestination(supabase, reqs, params.tripId);
  const wrongDestination = activityRows.filter((a) => a.destination_id !== destinationRow.id);
  if (wrongDestination.length > 0) {
    throw new InvalidActivitiesSelectionError(
      params.tripId,
      `activities belong to a different destination: ${wrongDestination.map((a) => a.id).join(", ")}`,
    );
  }

  const scheduledActivities: ScheduledActivity[] = params.scheduledActivities.map((a) => {
    const activity = activityById.get(a.id)!;
    return {
      id: a.id,
      date: a.date,
      startMinutes: a.startMinutes,
      durationMinutes: a.durationMinutes,
      openingHours: activity.opening_hours as OpeningHours | null,
      closedDays: activity.closed_days,
    };
  });

  const draft = buildDraft(ctx, scheduledActivities);
  const feasibility = validateItineraryFeasibility(draft);
  await recordGuardrailEvent(supabase, {
    tripId: params.tripId,
    agentName: AGENT_NAME,
    guardrailName: "itinerary_feasibility",
    layer: "domain_validation",
    triggered: !feasibility.valid,
    detail: feasibility.valid ? null : feasibility.violations.map((v) => v.message).join("; "),
    workflowRunId: run.id,
  });
  if (!feasibility.valid) {
    throw new InvalidActivitiesSelectionError(
      params.tripId,
      `schedule is no longer feasible: ${feasibility.violations.map((v) => v.message).join("; ")}`,
    );
  }

  const partySize = reqs.get("partySize") as number;
  const roomGroups = (reqs.get("roomGroups") as RoomGroup[] | undefined) ?? [{ occupants: partySize }];
  const budgetTotalUsd = reqs.get("budgetTotalUsd") as number;
  const nights = nightsBetween(dateRange(ctx.checkIn, ctx.checkOut));
  const budget = calculateBudget({
    currency: "USD",
    travelers: partySize,
    targetUsd: budgetTotalUsd,
    flights: [
      { priceUsd: ctx.outboundFlight.price_usd, taxesFeesUsd: ctx.outboundFlight.taxes_fees_usd },
      { priceUsd: ctx.returnFlight.price_usd, taxesFeesUsd: ctx.returnFlight.taxes_fees_usd },
    ],
    hotel: {
      pricePerNightUsd: ctx.hotel.price_per_night_usd,
      taxesFeesUsd: ctx.hotel.taxes_fees_usd,
      nights,
      rooms: roomGroups.length,
    },
    activities: scheduledActivities.map((s) => ({
      id: s.id,
      priceUsd: activityById.get(s.id)!.price_usd ?? undefined,
      partySize,
    })),
  });

  const startedAt = Date.now();
  let itineraryText: string | null = null;
  try {
    const writerResult = await runItineraryWriterAgent(modelClient, {
      selections: buildWriterSelections(ctx, scheduledActivities, activityById),
    });
    const incompleteStopReason = writerResult.stopReason !== "end_turn" && writerResult.stopReason !== "tool_use";
    const agentRun = await recordAgentRun(supabase, {
      tripId: params.tripId,
      workflowRunId: run.id,
      agentName: WRITER_AGENT_NAME,
      model: modelClient.model,
      usage: writerResult.usage,
      latencyMs: Date.now() - startedAt,
      costUsd: estimateCostUsd(modelClient.model, writerResult.usage),
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
      tripId: params.tripId,
      agentName: WRITER_AGENT_NAME,
      guardrailName: "itinerary_writer_grounding",
      layer: "domain_validation",
      triggered: writerResult.referenceCheck !== null && !writerResult.referenceCheck.valid,
      detail:
        writerResult.referenceCheck && !writerResult.referenceCheck.valid
          ? `unresolved ids: ${writerResult.referenceCheck.unresolvedIds.join(", ")}`
          : null,
      workflowRunId: run.id,
    });
    itineraryText = writerResult.itinerary?.explanation ?? null;
  } catch (err) {
    // Non-fatal: prose is a presentation concern on top of the already-valid
    // deterministic schedule/budget, same as the old pipeline's rationale.
    await recordAgentRun(supabase, {
      tripId: params.tripId,
      workflowRunId: run.id,
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
    ["activities", params.scheduledActivities as unknown as Json],
    ["budget", budget as unknown as Json],
  ];
  if (itineraryText) decisions.push(["itineraryText", itineraryText]);
  for (const [field, value] of decisions) {
    await retireActiveTripDecisionsForField(supabase, params.tripId, field);
    await appendTripDecision(supabase, { tripId: params.tripId, field, value, source: "system_computed", status: "confirmed" });
  }

  await appendTripEvent(supabase, {
    tripId: params.tripId,
    eventType: "activities_step_confirmed",
    payload: { scheduledActivityIds: params.scheduledActivities.map((a) => a.id) } as unknown as Json,
    correlationId: deriveCorrelationId(correlationId, "event:activities_step_confirmed"),
  });

  return { scheduledActivities: params.scheduledActivities, budget, itineraryText };
}
