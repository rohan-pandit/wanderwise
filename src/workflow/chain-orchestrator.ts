/**
 * INTERIM glue for the stepwise chain redesign
 * (`docs/IMPLEMENTATION_PLAN.md`'s "STEPWISE CHAIN REDESIGN" section),
 * built as part of slice 3. Drives `flight-step.ts` -> `hotel-step.ts` ->
 * `activities-step.ts` end to end, auto-confirming each step's top-ranked
 * candidate, so the chat UI (`app/app/actions.ts`) keeps auto-completing a
 * trip exactly as it did under the old one-shot pipeline (retired this
 * slice) rather than stalling until slice 4 rebuilds the chat UI to show
 * one step at a time and wait for a real user confirm/change. Decided
 * directly with the user before writing this, not assumed — nothing in
 * this file is meant to survive slice 4; it's scaffolding for the gap
 * between "the steps exist" and "the UI shows them one at a time."
 *
 * `runStepwiseChain` picks up from wherever the chain currently stands
 * (`src/domain/chain.ts`'s `getCurrentChainStep`, its first real caller) and
 * completes every remaining step — this is what makes it reusable both for
 * the initial forward pass (nothing confirmed yet) and for finishing
 * whatever a revision's cascade invalidated downstream.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import type { ModelClient } from "@/src/agents/model-client";
import { getCurrentChainStep } from "@/src/domain/chain";
import { listActiveTripDecisions } from "@/src/repositories/trip-decisions";
import type { EmbeddingClient } from "@/src/retrieval/embedding-client";
import { confirmActivitiesStep, proposeActivitiesStep, type ProposedScheduledActivity } from "./activities-step";
import { confirmFlightStep, proposeFlightStep } from "./flight-step";
import { confirmHotelStep, proposeHotelStep } from "./hotel-step";
import type { RevisableDecisionField } from "./step-shared";

export interface StepwiseChainClients {
  /** Ranks activity candidates (`activities-step.ts`'s `proposeActivitiesStep`). */
  curatorModelClient: ModelClient;
  /** Writes the final itinerary prose (`activities-step.ts`'s `confirmActivitiesStep`). */
  writerModelClient: ModelClient;
  embeddingClient: EmbeddingClient;
}

export interface RunStepwiseChainParams extends StepwiseChainClients {
  tripId: string;
}

export interface RunStepwiseChainResult {
  /** Null until the activities step (the chain's last step) actually runs and confirms — e.g. when the chain was already complete on entry. */
  itineraryText: string | null;
}

/**
 * Auto-confirms the top-ranked candidate at whichever step is next, then
 * moves on, until the whole chain is confirmed. Each step is proposed and
 * confirmed with its own real validation (hard constraints, feasibility,
 * inventory references) — this only automates the *choice*, not the
 * checks.
 */
export async function runStepwiseChain(
  supabase: SupabaseClient<Database>,
  params: RunStepwiseChainParams,
): Promise<RunStepwiseChainResult> {
  let step = getCurrentChainStep(await listActiveTripDecisions(supabase, params.tripId));

  if (step === "flight") {
    const proposal = await proposeFlightStep(supabase, { tripId: params.tripId });
    const chosen = proposal.candidates[0];
    await confirmFlightStep(supabase, {
      tripId: params.tripId,
      outboundFlightId: chosen.outboundFlight.id,
      returnFlightId: chosen.returnFlight.id,
    });
    step = "hotel";
  }

  if (step === "hotel") {
    const proposal = await proposeHotelStep(supabase, { tripId: params.tripId });
    const chosen = proposal.candidates[0];
    await confirmHotelStep(supabase, { tripId: params.tripId, hotelId: chosen.id });
    step = "activities";
  }

  if (step === "activities") {
    const proposal = await proposeActivitiesStep(supabase, params.curatorModelClient, params.embeddingClient, { tripId: params.tripId });
    const confirmed = await confirmActivitiesStep(supabase, params.writerModelClient, {
      tripId: params.tripId,
      scheduledActivities: proposal.scheduledActivities,
    });
    return { itineraryText: confirmed.itineraryText };
  }

  return { itineraryText: null };
}

export interface RunStepwiseRevisionParams extends StepwiseChainClients {
  tripId: string;
  field: RevisableDecisionField;
}

/**
 * Re-proposes and re-confirms the requested step, explicitly excluding the
 * currently-confirmed pick (otherwise a deterministic re-propose against
 * unchanged requirements would almost always return the exact same
 * candidate — the original bug this whole redesign exists to fix), then
 * runs `runStepwiseChain` to fill back in whatever the flight->hotel/
 * activities cascade invalidated downstream as a result.
 *
 * Real gap caught live (not by unit tests): rule 3 correctly keeps a hotel
 * (or same-dates flight) revision from invalidating the activities step —
 * but budget/itineraryText are computed *inside* `confirmActivitiesStep`,
 * not their own chain step, so when activities isn't invalidated,
 * `runStepwiseChain` alone would leave them stale (the written itinerary
 * would still name the old hotel at its old price). When the chain is
 * still `"complete"` after the revision (nothing downstream was
 * invalidated) but the revised field was hotel/flight, this refreshes
 * budget/itineraryText by re-running `confirmActivitiesStep` with the
 * *same* already-confirmed activity schedule — no re-search, re-curation,
 * or re-scheduling, just recomputing the two things that actually depend
 * on the hotel's price/name.
 */
export async function runStepwiseRevision(
  supabase: SupabaseClient<Database>,
  params: RunStepwiseRevisionParams,
): Promise<RunStepwiseChainResult> {
  const decisions = await listActiveTripDecisions(supabase, params.tripId);
  const confirmedValue = (field: string) => decisions.find((d) => d.field === field && d.status === "confirmed")?.value as string | undefined;

  if (params.field === "outboundFlight" || params.field === "returnFlight") {
    const proposal = await proposeFlightStep(supabase, {
      tripId: params.tripId,
      excludeOutboundFlightId: params.field === "outboundFlight" ? confirmedValue("outboundFlight") : undefined,
      excludeReturnFlightId: params.field === "returnFlight" ? confirmedValue("returnFlight") : undefined,
    });
    const chosen = proposal.candidates[0];
    await confirmFlightStep(supabase, {
      tripId: params.tripId,
      outboundFlightId: chosen.outboundFlight.id,
      returnFlightId: chosen.returnFlight.id,
    });
  } else {
    const proposal = await proposeHotelStep(supabase, { tripId: params.tripId, excludeHotelId: confirmedValue("hotel") });
    const chosen = proposal.candidates[0];
    await confirmHotelStep(supabase, { tripId: params.tripId, hotelId: chosen.id });
  }

  const decisionsAfter = await listActiveTripDecisions(supabase, params.tripId);
  if (getCurrentChainStep(decisionsAfter) !== "complete") {
    return runStepwiseChain(supabase, params);
  }

  const activitiesDecision = decisionsAfter.find((d) => d.field === "activities" && d.status === "confirmed");
  if (!activitiesDecision) {
    return { itineraryText: null };
  }
  const confirmed = await confirmActivitiesStep(supabase, params.writerModelClient, {
    tripId: params.tripId,
    scheduledActivities: activitiesDecision.value as unknown as ProposedScheduledActivity[],
  });
  return { itineraryText: confirmed.itineraryText };
}
