/**
 * The activities step of the stepwise chain redesign
 * (`docs/IMPLEMENTATION_PLAN.md`'s "STEPWISE CHAIN REDESIGN" section,
 * decided 2026-09-17) — slice 3, the last step in the chain.
 *
 * Redesigned 2026-09-18 (`docs/IMPLEMENTATION_PLAN.md`'s "ACTIVITIES:
 * PREFERENCE-DRIVEN MULTI-SELECT" section) from a fully auto-curated,
 * auto-scheduled, no-user-choice pipeline into a real pick-list, matching
 * flight/hotel's propose-a-list/user-picks shape — found live during the
 * user's own manual e2e testing pass that the old design surfaced nothing
 * but bare dates/times, with no activity name ever reaching the UI and no
 * way for the user to actually choose what they wanted to do. The four
 * functions below replace the old two (`proposeActivitiesStep`/
 * `confirmActivitiesStep`):
 *
 * 1. `proposeActivitiesStep` — given a UI-submitted preference (category
 *    chips + optional free text, `app/app/actions.ts`'s
 *    `proposeActivityCandidates`), retrieves + curates candidates and
 *    returns them richly (name/category/price/description), NOT scheduled
 *    yet. Persists the given preference as real `trip_preferences` rows
 *    (`activityInterests`/`activityNotes`) so a page reload can rebuild the
 *    same query, and the candidates as `"proposed"` `activityCandidate`
 *    decisions (reload-survival signature, same reasoning as flight/hotel's
 *    slice-4 persistence — not itself the UI's data source, which is this
 *    function's return value).
 * 2. `confirmActivitySelection` — adds exactly one candidate to the trip, as
 *    its own `"confirmed"` `"activity"` decision row (multiple rows share
 *    this field name, unlike flight's `outboundFlight`/`returnFlight` —
 *    there's no "slot" identity here, just "pick as many as you want").
 * 3. `removeActivitySelection` — the inverse: retires one confirmed
 *    `"activity"` row by activity id.
 * 4. `finalizeActivitiesStep` (the old `confirmActivitiesStep`, renamed to
 *    distinguish it from #2's per-activity confirm) — reads every currently
 *    confirmed `"activity"` row, and *only now* runs the deterministic
 *    scheduler (reused as-is) to place them into date/time slots, computes
 *    the budget, runs the Itinerary Writer, and writes the final
 *    `"activities"`/`"budget"`/`"itineraryText"` confirmed decisions —
 *    still the chain's terminal step, same completion signal
 *    (`src/domain/chain.ts`'s `getCurrentChainStep` only ever checks for a
 *    confirmed `"activities"` row, unaffected by the new per-pick `"activity"`
 *    rows existing alongside it).
 *
 * What's unchanged: this can still only propose once hotel is confirmed
 * (scheduling needs the confirmed flight's derived stay dates); the
 * deterministic scheduler/feasibility/budget/curator-reference-check/
 * writer-grounding machinery are all reused exactly as before, just invoked
 * at a different point (finalize time, not propose time) and over a
 * user-picked set instead of a curator-auto-picked one.
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
  retireTripDecisionById,
} from "@/src/repositories/trip-decisions";
import { appendTripEvent } from "@/src/repositories/trip-events";
import {
  appendTripPreference,
  listActiveTripPreferences,
  retireActiveTripPreferencesForField,
} from "@/src/repositories/trip-preferences";
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

/** A given activity id doesn't match any currently-confirmed `"activity"` decision for this trip — `removeActivitySelection` on something never added, or already removed. */
export class ActivityNotSelectedError extends Error {
  constructor(tripId: string, activityId: string) {
    super(`Trip ${tripId}: activity ${activityId} isn't currently selected.`);
    this.name = "ActivityNotSelectedError";
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

/** A retrieved/curated activity, not yet picked — what `proposeActivitiesStep` returns for the UI's candidate cards. Deliberately lean (no opening hours/closed days/vibe tags): those still drive scheduling internally, but per the redesign's own scope, precise time handling is a lower priority than just letting the user see and pick real activities by name. */
export interface ActivityCandidate {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  priceUsd: number;
  durationMinutes: number | null;
  location: string | null;
  reservationRequired: boolean;
}

function toActivityCandidate(activity: MatchedActivity): ActivityCandidate {
  return {
    id: activity.id,
    name: activity.name,
    category: activity.category,
    description: activity.description,
    priceUsd: activity.price_usd,
    durationMinutes: activity.duration_minutes,
    location: activity.location,
    reservationRequired: activity.reservation_required,
  };
}

export interface ProposeActivitiesStepParams {
  tripId: string;
  /** Idempotency key for the logged `trip_events` row — see `deriveCorrelationId`. Defaults to a fresh UUID if omitted. */
  correlationId?: string;
  /**
   * Category chips selected in the UI-driven preference form
   * (`activities.category` values, e.g. "food"/"spa"/"nightlife") — applied
   * as a hard filter (`categoryConstraint`) when non-empty. `undefined`
   * (the caller didn't submit a new preference this call — e.g. a page
   * reload's auto-re-propose) falls back to whatever was already stored
   * (`activityInterests`); pass `[]` explicitly to mean "no category filter"
   * instead of falling back. Written to `trip_preferences` only when
   * explicitly provided, not on every fallback re-propose.
   */
  categories?: string[];
  /** Optional free-text supplement ("nothing too touristy") — same fallback-when-undefined behavior as `categories`, against the `activityNotes` preference. Folded into the retrieval query text and passed to the Curator as `criteria` for nuance beyond the category filter. */
  criteria?: string;
}

export interface ProposeActivitiesStepResult {
  /** Ranked, richly-detailed candidates — NOT scheduled yet. The user picks from these via `confirmActivitySelection`. */
  candidates: ActivityCandidate[];
  /** Activities already confirmed for this trip (from an earlier call in the same session, or a page reload) — richly detailed the same way, so the UI's "already in your itinerary" list has real names without a separate fetch. */
  alreadySelected: ActivityCandidate[];
  /** Null if there were no candidates to curate, or the agent's call didn't validate — candidates are still returned either way (rank order just falls back to retrieval order). */
  curation: CurationOutput | null;
}

/**
 * Retrieves and curates activity candidates against a UI-submitted
 * preference — no scheduling, no persistence of a final pick, purely a
 * pick-list for the user (see this module's own header for the full
 * redesign). Automatically excludes anything already confirmed for this
 * trip, so a repeat call ("show me more") doesn't just re-offer what's
 * already been added.
 */
export async function proposeActivitiesStep(
  supabase: SupabaseClient<Database>,
  modelClient: ModelClient,
  embeddingClient: EmbeddingClient,
  params: ProposeActivitiesStepParams,
): Promise<ProposeActivitiesStepResult> {
  const correlationId = params.correlationId ?? randomUUID();

  // Only the validation side-effect matters here (throws if flight/hotel
  // aren't confirmed yet) — unlike `finalizeActivitiesStep`, propose doesn't
  // schedule anything, so it never needs the confirmed stay dates this
  // returns.
  await loadConfirmedContext(supabase, params.tripId);

  const [requirementRows, existingDecisions, existingPreferences, run] = await Promise.all([
    listActiveTripRequirements(supabase, params.tripId),
    listActiveTripDecisions(supabase, params.tripId),
    listActiveTripPreferences(supabase, params.tripId),
    getOrCreateActiveWorkflowRun(supabase, params.tripId),
  ]);
  const reqs = requirementMap(requirementRows);
  const destinationRow = await resolveTripDestination(supabase, reqs, params.tripId);

  const alreadySelectedIds = existingDecisions
    .filter((d) => d.field === "activity" && d.status === "confirmed")
    .map((d) => d.value as string);

  // Falls back to whatever was already stored when the caller didn't submit
  // a new preference this call (a page reload's auto-re-propose, see
  // `ProposeActivitiesStepParams`'s own docstring) — only a genuine new
  // submission gets persisted, so a reload-triggered re-propose doesn't
  // retire-and-reappend the same unchanged value every time.
  const storedInterests = existingPreferences.find((p) => p.field === "activityInterests")?.value as string[] | undefined;
  const storedNotes = existingPreferences.find((p) => p.field === "activityNotes")?.value as string | undefined;
  const categories = (params.categories ?? storedInterests ?? []).filter((c) => c.trim().length > 0);
  const criteria = (params.criteria !== undefined ? params.criteria : storedNotes)?.trim() || undefined;

  if (params.categories !== undefined) {
    await retireActiveTripPreferencesForField(supabase, params.tripId, "activityInterests");
  }
  if (params.categories !== undefined && categories.length > 0) {
    await appendTripPreference(supabase, {
      tripId: params.tripId,
      field: "activityInterests",
      value: categories as unknown as Json,
      source: "user_explicit",
      confidence: 1,
    });
  }
  if (params.criteria !== undefined) {
    await retireActiveTripPreferencesForField(supabase, params.tripId, "activityNotes");
  }
  if (params.criteria !== undefined && criteria) {
    await appendTripPreference(supabase, {
      tripId: params.tripId,
      field: "activityNotes",
      value: criteria,
      source: "user_explicit",
      confidence: 1,
    });
  }

  const alreadySelectedIdSet = new Set(alreadySelectedIds);
  const [rawCandidates, alreadySelectedActivities] = await Promise.all([
    retrieveActivities(supabase, embeddingClient, {
      destination: destinationRow.name,
      destinationId: destinationRow.id,
      query: criteria,
      categories: categories.length > 0 ? categories : undefined,
      excludeClosedOnDays: reqs.get("excludeClosedOnDays") as string[] | undefined,
      accessibilityNeeds: reqs.get("requiredAccessibility") as string[] | undefined,
      maxPriceUsd: reqs.get("maxActivityPriceUsd") as number | undefined,
      topK: ACTIVITY_TOP_K + alreadySelectedIds.length,
    }),
    getActivitiesByIds(supabase, alreadySelectedIds),
  ]);
  const candidateActivities = rawCandidates.filter((a) => !alreadySelectedIdSet.has(a.id));

  let curation: CurationOutput | null = null;
  if (candidateActivities.length > 0) {
    const startedAt = Date.now();
    const curatorResult = await runCuratorAgent(modelClient, {
      kind: "activity",
      preferences: [
        ...(categories.length > 0 ? [{ field: "activityInterests", value: categories }] : []),
        ...(criteria ? [{ field: "activityNotes", value: criteria }] : []),
      ],
      candidates: candidateActivities,
      criteria,
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

  // Persisted as "proposed" (stepwise chain redesign slice 4) purely as a
  // reload-survival signature, same reasoning as flight/hotel — the UI's
  // actual candidate data comes from this function's return value, not from
  // re-reading these rows (they hold just the id, not the full candidate).
  await retireProposedTripDecisionsForField(supabase, params.tripId, "activityCandidate");
  for (const activity of orderedActivities) {
    await appendTripDecision(supabase, {
      tripId: params.tripId,
      field: "activityCandidate",
      value: activity.id,
      source: "system_computed",
      status: "proposed",
    });
  }

  await appendTripEvent(supabase, {
    tripId: params.tripId,
    eventType: "activities_step_proposed",
    payload: { candidateActivityIds: orderedActivities.map((a) => a.id), categories, criteria: criteria ?? null } as unknown as Json,
    correlationId: deriveCorrelationId(correlationId, "event:activities_step_proposed"),
  });

  return {
    candidates: orderedActivities.map(toActivityCandidate),
    alreadySelected: alreadySelectedActivities.map(toActivityCandidate),
    curation,
  };
}

export interface ConfirmActivitySelectionParams {
  tripId: string;
  activityId: string;
  /** Idempotency key for the logged `trip_events` row — see `deriveCorrelationId`. Defaults to a fresh UUID if omitted. */
  correlationId?: string;
}

export interface ConfirmActivitySelectionResult {
  activity: ActivityCandidate;
}

/**
 * Adds one activity to the trip — its own `"confirmed"` `"activity"`
 * decision row, alongside however many others are already confirmed (no
 * "slot" identity, unlike flight/hotel). Re-validates the id the same way
 * `confirmFlightStep`/`confirmHotelStep` do (destination match, inventory
 * freshness) rather than trusting a propose result computed moments
 * earlier. A no-op-with-success (not an error) if the activity is already
 * selected — clicking "Add" twice shouldn't create two rows or fail loudly.
 */
export async function confirmActivitySelection(
  supabase: SupabaseClient<Database>,
  params: ConfirmActivitySelectionParams,
): Promise<ConfirmActivitySelectionResult> {
  const correlationId = params.correlationId ?? randomUUID();

  const [activityRows, requirementRows, existingDecisions] = await Promise.all([
    getActivitiesByIds(supabase, [params.activityId]),
    listActiveTripRequirements(supabase, params.tripId),
    listActiveTripDecisions(supabase, params.tripId),
  ]);
  const activity = activityRows[0];
  if (!activity) {
    throw new InvalidActivitiesSelectionError(params.tripId, `unresolved activity id: ${params.activityId}`);
  }

  const reqs = requirementMap(requirementRows);
  const destinationRow = await resolveTripDestination(supabase, reqs, params.tripId);
  if (activity.destination_id !== destinationRow.id) {
    throw new InvalidActivitiesSelectionError(params.tripId, `activity ${activity.id} belongs to a different destination`);
  }
  if (activity.inventory_version !== destinationRow.inventory_version) {
    throw new InvalidActivitiesSelectionError(
      params.tripId,
      `stale inventory version: ${activity.id} (v${activity.inventory_version}) — current is v${destinationRow.inventory_version}.`,
    );
  }

  const alreadySelected = existingDecisions.some(
    (d) => d.field === "activity" && d.status === "confirmed" && d.value === activity.id,
  );
  if (!alreadySelected) {
    await appendTripDecision(supabase, {
      tripId: params.tripId,
      field: "activity",
      value: activity.id,
      source: "user_explicit",
      status: "confirmed",
    });
    await appendTripEvent(supabase, {
      tripId: params.tripId,
      eventType: "activity_selected",
      payload: { activityId: activity.id } as unknown as Json,
      correlationId: deriveCorrelationId(correlationId, `event:activity_selected:${activity.id}`),
    });
  }

  return { activity: toActivityCandidate(activity) };
}

export interface RemoveActivitySelectionParams {
  tripId: string;
  activityId: string;
  correlationId?: string;
}

/** The inverse of `confirmActivitySelection` — retires the one confirmed `"activity"` row matching this id, leaving every other selection untouched (`retireTripDecisionById`, not the field-wide retire helpers, since multiple rows share the `"activity"` field name). */
export async function removeActivitySelection(
  supabase: SupabaseClient<Database>,
  params: RemoveActivitySelectionParams,
): Promise<void> {
  const correlationId = params.correlationId ?? randomUUID();

  const decisions = await listActiveTripDecisions(supabase, params.tripId);
  const match = decisions.find((d) => d.field === "activity" && d.status === "confirmed" && d.value === params.activityId);
  if (!match) {
    throw new ActivityNotSelectedError(params.tripId, params.activityId);
  }
  await retireTripDecisionById(supabase, params.tripId, match.id);
  await appendTripEvent(supabase, {
    tripId: params.tripId,
    eventType: "activity_deselected",
    payload: { activityId: params.activityId } as unknown as Json,
    correlationId: deriveCorrelationId(correlationId, `event:activity_deselected:${params.activityId}`),
  });
}

export interface FinalizeActivitiesStepParams {
  tripId: string;
  /** Idempotency key for the logged `trip_events` row — see `deriveCorrelationId`. Defaults to a fresh UUID if omitted. */
  correlationId?: string;
}

export interface ProposedScheduledActivity {
  id: string;
  name: string;
  category: string | null;
  priceUsd: number;
  date: string;
  startMinutes: number;
  durationMinutes: number;
}

export interface FinalizeActivitiesStepResult {
  scheduledActivities: ProposedScheduledActivity[];
  /** Selected-but-couldn't-fit activities — not an error, just not schedulable this trip (the user picked more than the date range/hours can hold). */
  unscheduledActivityIds: string[];
  budget: BudgetBreakdown;
  itineraryText: string | null;
}

/**
 * Schedules every currently-confirmed `"activity"` selection into the
 * confirmed flight's derived stay dates, computes the budget, and runs the
 * Itinerary Writer — the chain's terminal step (the old `confirmActivitiesStep`,
 * renamed to distinguish it from `confirmActivitySelection`'s per-pick add).
 * Re-validates every selected id the same way the old function did
 * (destination match, inventory-version staleness) before scheduling
 * anything, rather than trusting the confirmed rows are still accurate.
 */
export async function finalizeActivitiesStep(
  supabase: SupabaseClient<Database>,
  modelClient: ModelClient,
  params: FinalizeActivitiesStepParams,
): Promise<FinalizeActivitiesStepResult> {
  const correlationId = params.correlationId ?? randomUUID();

  const ctx = await loadConfirmedContext(supabase, params.tripId);

  const [decisions, requirementRows, run] = await Promise.all([
    listActiveTripDecisions(supabase, params.tripId),
    listActiveTripRequirements(supabase, params.tripId),
    getOrCreateActiveWorkflowRun(supabase, params.tripId),
  ]);
  const activityIds = decisions.filter((d) => d.field === "activity" && d.status === "confirmed").map((d) => d.value as string);

  const activityRows = await getActivitiesByIds(supabase, activityIds);
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
  // Defense in depth against a stale-inventory-version ID reaching finalize
  // directly (each confirmActivitySelection call already checked this at
  // add-time — this closes the same gap for anything that changed since).
  const staleActivities = activityRows.filter((a) => a.inventory_version !== destinationRow.inventory_version);
  if (staleActivities.length > 0) {
    throw new InvalidActivitiesSelectionError(
      params.tripId,
      `stale inventory version: ${staleActivities.map((a) => `${a.id} (v${a.inventory_version})`).join(", ")} — current is v${destinationRow.inventory_version}.`,
    );
  }

  const earliestStartByDate = {
    [ctx.checkIn]: localMinutesOfDay(ctx.outboundFlight.arrival_time, ctx.destinationTimeZone) + DEFAULT_TRANSFER_BUFFER_MINUTES,
  };
  const latestEndByDate = {
    [ctx.checkOut]: localMinutesOfDay(ctx.returnFlight.departure_time, ctx.destinationTimeZone) - DEFAULT_TRANSFER_BUFFER_MINUTES,
  };
  const schedule = scheduleActivities({
    activities: activityRows.map((a) => ({
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
  if (!feasibility.valid) {
    throw new InvalidActivitiesSelectionError(
      params.tripId,
      `schedule is no longer feasible: ${feasibility.violations.map((v) => v.message).join("; ")}`,
    );
  }

  const proposedScheduledActivities: ProposedScheduledActivity[] = scheduledActivities.map((a) => {
    const activity = activityById.get(a.id)!;
    return {
      id: a.id,
      name: activity.name,
      category: activity.category,
      priceUsd: activity.price_usd,
      date: a.date,
      startMinutes: a.startMinutes,
      durationMinutes: a.durationMinutes,
    };
  });

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

  const decisionsToWrite: [string, Json][] = [
    ["activities", proposedScheduledActivities as unknown as Json],
    ["budget", budget as unknown as Json],
  ];
  if (itineraryText) decisionsToWrite.push(["itineraryText", itineraryText]);
  for (const [field, value] of decisionsToWrite) {
    await retireActiveTripDecisionsForField(supabase, params.tripId, field);
    await appendTripDecision(supabase, { tripId: params.tripId, field, value, source: "system_computed", status: "confirmed" });
  }

  await appendTripEvent(supabase, {
    tripId: params.tripId,
    eventType: "activities_step_confirmed",
    payload: { scheduledActivityIds: proposedScheduledActivities.map((a) => a.id), unscheduledActivityIds: schedule.unscheduled } as unknown as Json,
    correlationId: deriveCorrelationId(correlationId, "event:activities_step_confirmed"),
  });

  return { scheduledActivities: proposedScheduledActivities, unscheduledActivityIds: schedule.unscheduled, budget, itineraryText };
}
