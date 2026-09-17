/**
 * The Orchestrator step (PROJECT_BRIEF.md §6.2/§6.3) that picks up where
 * `intake-orchestrator.ts` leaves off, once a trip reaches
 * `requirements_ready`. Scoped deliberately (docs/IMPLEMENTATION_PLAN.md
 * "Phase 6, continued", slice 1 — search + Curator wiring only):
 *
 * 1. Deterministically search flights/hotels from validated
 *    `trip_requirements` — `PROJECT_BRIEF.md` §12's own notes column already
 *    describes these as an "orchestrator-driven search step," not a live
 *    model tool call, the same precedent Phase 5 set for
 *    `retrieve_destinations`/`retrieve_activities`. No model judgment is
 *    involved in constructing the search itself.
 * 2. Hard-constraint-filter the results (`src/domain/constraints.ts`, Phase
 *    2) — defense in depth beyond whatever the repository query params
 *    already narrowed, since §9.5 requires hard constraints to be enforced
 *    by code, not assumed correct because a query happened to include them.
 * 3. Retrieve candidate activities (`src/retrieval/activities-retrieval.ts`,
 *    Phase 5).
 * 4. Run the Destination and Activity Curator agent (`src/agents/curator.ts`,
 *    Phase 5) to rank the activity candidates against stated preferences.
 *
 * Stops at `assembling_options` with a ranked candidate set. Combining
 * flights+hotels+activities into a priced, feasible itinerary and persisting
 * selections to `trip_decisions` is `src/workflow/itinerary-orchestrator.ts`
 * (slice 2) — see docs/IMPLEMENTATION_PLAN.md.
 *
 * Destinations are not searched here: `destination` is a required
 * `trip_requirements` field (`REQUIRED_FOR_READY`), so by the time a trip
 * reaches `requirements_ready` it's already fixed — the "flexible
 * destination" case `retrieve_destinations`/Curator-for-destinations exists
 * for isn't reachable in this project's current required-field model.
 *
 * `flights` is a one-way table (`supabase/migrations/0001_initial_schema.sql`),
 * so a round trip needs a second, reversed-direction search for the return
 * leg — `returnDate` is optional (`REQUIRED_FOR_READY` doesn't require it),
 * so a one-way trip simply skips it (`returnFlights` comes back empty).
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/src/config/supabase/database.types";
import { runCuratorAgent } from "@/src/agents/curator";
import type { ModelClient } from "@/src/agents/model-client";
import {
  filterHardConstraints,
  maxFlightPriceConstraint,
  minHotelRatingConstraint,
  noRedEyeConstraint,
  refundableConstraint,
  roomCapacityConstraint,
  type HardConstraint,
} from "@/src/domain/constraints";
import type { CurationOutput } from "@/src/domain/curation";
import type { RequirementFieldName } from "@/src/domain/extraction";
import type { RoomGroup } from "@/src/domain/rooms";
import { recordAgentRun, recordToolCalls } from "@/src/repositories/agent-runs";
import type { MatchedActivity } from "@/src/repositories/activities";
import { findFlights, type Flight } from "@/src/repositories/flights";
import { recordGuardrailEvent } from "@/src/repositories/guardrail-events";
import { findHotels, type Hotel } from "@/src/repositories/hotels";
import { appendTripEvent } from "@/src/repositories/trip-events";
import { listActiveTripPreferences } from "@/src/repositories/trip-preferences";
import { listActiveTripRequirements, type TripRequirementRow } from "@/src/repositories/trip-requirements";
import { getLatestTripState } from "@/src/repositories/trip-state";
import { getOrCreateActiveWorkflowRun } from "@/src/repositories/workflow-runs";
import type { EmbeddingClient } from "@/src/retrieval/embedding-client";
import { retrieveActivities } from "@/src/retrieval/activities-retrieval";
import { advanceOrThrow } from "./advance";
import { deriveCorrelationId } from "./correlation";
import type { WorkflowState } from "./state-machine";

const AGENT_NAME = "destination_and_activity_curator";
const ACTIVITY_TOP_K = 10;

export class InvalidWorkflowStateError extends Error {
  constructor(tripId: string, actual: WorkflowState, expected: WorkflowState) {
    super(`Trip ${tripId} is in state "${actual}" — search can only begin from "${expected}".`);
    this.name = "InvalidWorkflowStateError";
  }
}

/** Thrown after driving the workflow into `failed_recoverable` — a real, resumable outcome (§8.4), not a bug. */
export class NoViableCandidatesError extends Error {
  constructor(tripId: string, detail: string) {
    super(`Trip ${tripId}: search returned no viable candidates — ${detail}`);
    this.name = "NoViableCandidatesError";
  }
}

function requirementMap(rows: TripRequirementRow[]): Map<RequirementFieldName, unknown> {
  const map = new Map<RequirementFieldName, unknown>();
  for (const row of rows) map.set(row.field as RequirementFieldName, row.value);
  return map;
}

/** Flattens preference values (each a string or string[]) into a flat list of free-text terms — for building a semantic search query, never a hard metadata filter (see the caller's comment). */
function flattenPreferenceText(values: unknown[]): string[] {
  const terms: string[] = [];
  for (const value of values) {
    if (typeof value === "string") terms.push(value);
    else if (Array.isArray(value)) {
      for (const v of value) if (typeof v === "string") terms.push(v);
    }
  }
  return terms;
}

function flightHardConstraints(reqs: Map<RequirementFieldName, unknown>): HardConstraint<Flight>[] {
  const constraints: HardConstraint<Flight>[] = [];
  if (reqs.get("noRedEye") === true) constraints.push(noRedEyeConstraint());
  const maxFlightPriceUsd = reqs.get("maxFlightPriceUsd");
  if (typeof maxFlightPriceUsd === "number") constraints.push(maxFlightPriceConstraint(maxFlightPriceUsd));
  return constraints;
}

function hotelHardConstraints(reqs: Map<RequirementFieldName, unknown>, roomGroups: RoomGroup[]): HardConstraint<Hotel>[] {
  const constraints: HardConstraint<Hotel>[] = [roomCapacityConstraint(roomGroups)];
  const minHotelRating = reqs.get("minHotelRating");
  if (typeof minHotelRating === "number") constraints.push(minHotelRatingConstraint(minHotelRating));
  if (reqs.get("refundableHotel") === true) constraints.push(refundableConstraint());
  return constraints;
}

export interface RunSearchAndCurationParams {
  tripId: string;
  /** Idempotency key — see `deriveCorrelationId`. Defaults to a fresh UUID if omitted. */
  correlationId?: string;
}

export interface RunSearchAndCurationResult {
  workflowState: WorkflowState;
  outboundFlights: Flight[];
  /** Empty when the trip has no `returnDate` (one-way). */
  returnFlights: Flight[];
  hotels: Hotel[];
  activities: MatchedActivity[];
  /** Null if there were no activity candidates to curate, or the agent's call didn't validate. */
  curation: CurationOutput | null;
}

export async function runSearchAndCuration(
  supabase: SupabaseClient<Database>,
  modelClient: ModelClient,
  embeddingClient: EmbeddingClient,
  params: RunSearchAndCurationParams,
): Promise<RunSearchAndCurationResult> {
  const correlationId = params.correlationId ?? randomUUID();

  const currentState = await getLatestTripState(supabase, params.tripId);
  if (!currentState) {
    throw new Error(`Trip ${params.tripId} has no state history — call startTrip first.`);
  }
  if (currentState.state.workflowState !== "requirements_ready") {
    throw new InvalidWorkflowStateError(params.tripId, currentState.state.workflowState, "requirements_ready");
  }

  const [requirementRows, preferenceRows, run] = await Promise.all([
    listActiveTripRequirements(supabase, params.tripId),
    listActiveTripPreferences(supabase, params.tripId),
    getOrCreateActiveWorkflowRun(supabase, params.tripId),
  ]);
  const reqs = requirementMap(requirementRows);

  let workflowState = await advanceOrThrow(supabase, {
    tripId: params.tripId,
    event: "begin_search",
    actor: AGENT_NAME,
    correlationId: deriveCorrelationId(correlationId, "chain:begin_search"),
    agentName: AGENT_NAME,
    workflowRunId: run.id,
  });

  const origin = reqs.get("origin") as string;
  const destination = reqs.get("destination") as string;
  const departureDate = reqs.get("departureDate") as string;
  const returnDate = reqs.get("returnDate") as string | undefined;
  const partySize = reqs.get("partySize") as number;
  const roomGroups = (reqs.get("roomGroups") as RoomGroup[] | undefined) ?? [{ occupants: partySize }];

  // Preference values are free text the Intake agent extracted from the
  // user's own words (e.g. "relaxing, laid-back") — not drawn from the
  // seed data's controlled `vibe_tags` vocabulary (short curated slugs like
  // "boutique"/"culture"/"walkable" — see supabase/migrations/0002_seed_data.sql).
  // `findHotels`/`matchActivities` both treat `vibeTags` as a *hard*
  // `&&` (array-overlap) SQL filter (supabase/migrations/0005_retrieval.sql),
  // not a ranking signal — passing free text through it would zero out real
  // candidates whenever the wording doesn't happen to match the vocabulary
  // verbatim. Passed as `query` instead: `retrieveActivities` embeds it and
  // ranks semantically, which is exactly what free text should feed.
  // `findHotels` has no semantic path, so preferences don't filter hotels
  // in this slice.
  const preferenceQuery = flattenPreferenceText(preferenceRows.map((p) => p.value)).join(", ") || undefined;

  const [outboundCandidates, returnCandidates, hotelCandidates, activityCandidates] = await Promise.all([
    findFlights(supabase, {
      origin,
      destination,
      departureDate,
      maxPriceUsd: reqs.get("maxFlightPriceUsd") as number | undefined,
      excludeRedEye: reqs.get("noRedEye") === true,
    }),
    returnDate
      ? findFlights(supabase, {
          origin: destination,
          destination: origin,
          departureDate: returnDate,
          maxPriceUsd: reqs.get("maxFlightPriceUsd") as number | undefined,
          excludeRedEye: reqs.get("noRedEye") === true,
        })
      : Promise.resolve([] as Flight[]),
    findHotels(supabase, {
      destination,
      minRating: reqs.get("minHotelRating") as number | undefined,
    }),
    retrieveActivities(supabase, embeddingClient, {
      destination,
      query: preferenceQuery,
      excludeClosedOnDays: reqs.get("excludeClosedOnDays") as string[] | undefined,
      accessibilityNeeds: reqs.get("requiredAccessibility") as string[] | undefined,
      maxPriceUsd: reqs.get("maxActivityPriceUsd") as number | undefined,
      topK: ACTIVITY_TOP_K,
    }),
  ]);

  const outboundFilter = filterHardConstraints(outboundCandidates, flightHardConstraints(reqs));
  const returnFilter = filterHardConstraints(returnCandidates, flightHardConstraints(reqs));
  const hotelFilter = filterHardConstraints(hotelCandidates, hotelHardConstraints(reqs, roomGroups));

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
    returnDate
      ? recordGuardrailEvent(supabase, {
          tripId: params.tripId,
          agentName: AGENT_NAME,
          guardrailName: "return_flight_hard_constraints",
          layer: "domain_validation",
          triggered: returnFilter.rejected.length > 0,
          detail: returnFilter.rejected.length
            ? `${returnFilter.rejected.length} of ${returnCandidates.length} return flight(s) rejected: ${[...new Set(returnFilter.rejected.map((r) => r.code))].join(", ")}`
            : null,
          workflowRunId: run.id,
        })
      : Promise.resolve(),
    recordGuardrailEvent(supabase, {
      tripId: params.tripId,
      agentName: AGENT_NAME,
      guardrailName: "hotel_hard_constraints",
      layer: "domain_validation",
      triggered: hotelFilter.rejected.length > 0,
      detail: hotelFilter.rejected.length
        ? `${hotelFilter.rejected.length} of ${hotelCandidates.length} hotel(s) rejected: ${[...new Set(hotelFilter.rejected.map((r) => r.code))].join(", ")}`
        : null,
      workflowRunId: run.id,
    }),
    appendTripEvent(supabase, {
      tripId: params.tripId,
      eventType: "inventory_searched",
      payload: {
        outboundFlightCandidateIds: outboundFilter.passing.map((f) => f.id),
        returnFlightCandidateIds: returnFilter.passing.map((f) => f.id),
        hotelCandidateIds: hotelFilter.passing.map((h) => h.id),
        activityCandidateIds: activityCandidates.map((a) => a.id),
      },
      correlationId: deriveCorrelationId(correlationId, "event:inventory_searched"),
    }),
  ]);

  workflowState = await advanceOrThrow(supabase, {
    tripId: params.tripId,
    event: "search_completed",
    actor: AGENT_NAME,
    correlationId: deriveCorrelationId(correlationId, "chain:search_completed"),
    agentName: AGENT_NAME,
    workflowRunId: run.id,
  });

  const missing: string[] = [];
  if (outboundFilter.passing.length === 0) missing.push("no outbound flights passed hard constraints");
  if (returnDate && returnFilter.passing.length === 0) missing.push("no return flights passed hard constraints");
  if (hotelFilter.passing.length === 0) missing.push("no hotels passed hard constraints");

  if (missing.length > 0) {
    const detail = missing.join("; ");
    await advanceOrThrow(supabase, {
      tripId: params.tripId,
      event: "recoverable_error",
      actor: AGENT_NAME,
      correlationId: deriveCorrelationId(correlationId, "chain:recoverable_error"),
      agentName: AGENT_NAME,
      workflowRunId: run.id,
    });
    throw new NoViableCandidatesError(params.tripId, detail);
  }

  workflowState = await advanceOrThrow(supabase, {
    tripId: params.tripId,
    event: "candidates_valid",
    actor: AGENT_NAME,
    correlationId: deriveCorrelationId(correlationId, "chain:candidates_valid"),
    agentName: AGENT_NAME,
    workflowRunId: run.id,
  });

  let curation: CurationOutput | null = null;
  if (activityCandidates.length > 0) {
    const startedAt = Date.now();
    const curatorResult = await runCuratorAgent(modelClient, {
      kind: "activity",
      preferences: preferenceRows.map((p) => ({ field: p.field, value: p.value })),
      candidates: activityCandidates,
    });
    const latencyMs = Date.now() - startedAt;
    const incompleteStopReason = curatorResult.stopReason !== "end_turn" && curatorResult.stopReason !== "tool_use";
    const agentRun = await recordAgentRun(supabase, {
      tripId: params.tripId,
      workflowRunId: run.id,
      agentName: AGENT_NAME,
      model: modelClient.model,
      usage: curatorResult.usage,
      latencyMs,
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
      agentName: AGENT_NAME,
      guardrailName: "curation_reference_check",
      layer: "domain_validation",
      triggered: curatorResult.referenceCheck !== null && !curatorResult.referenceCheck.valid,
      detail:
        curatorResult.referenceCheck && !curatorResult.referenceCheck.valid
          ? `unresolved ids: ${curatorResult.referenceCheck.unresolvedIds.join(", ")}`
          : null,
      workflowRunId: run.id,
    });
    curation = curatorResult.curation;
    if (curation) {
      await appendTripEvent(supabase, {
        tripId: params.tripId,
        eventType: "activities_curated",
        payload: {
          rankedIds: curation.rankedIds,
          excludedIds: curation.excludedIds,
          rationale: curation.rationale,
        },
        correlationId: deriveCorrelationId(correlationId, "event:activities_curated"),
      });
    }
  }

  return {
    workflowState,
    outboundFlights: outboundFilter.passing,
    returnFlights: returnFilter.passing,
    hotels: hotelFilter.passing,
    activities: activityCandidates,
    curation,
  };
}
