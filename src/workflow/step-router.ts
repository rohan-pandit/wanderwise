/**
 * Real per-step propose routing for the stepwise chain redesign
 * (`docs/IMPLEMENTATION_PLAN.md`'s "STEPWISE CHAIN REDESIGN" section),
 * slice 4. Replaces `chain-orchestrator.ts`'s interim auto-confirm glue
 * (deleted this slice) — this module only ever *proposes*, deliberately
 * dropping the old module's auto-confirm-the-top-pick behavior. The user
 * confirms a specific candidate via a Server Action (`app/app/actions.ts`'s
 * `confirm*Candidate` functions), which call `flight-step.ts`/
 * `hotel-step.ts`/`activities-step.ts`'s `confirm*Step` directly — this
 * module never calls any of those.
 *
 * `proposeCurrentChainStep`/`advanceOrRefreshChain` return what they did
 * (which step, with what candidates) rather than `void` — the itinerary
 * panel consumes this directly to populate its candidate-card state, rather
 * than redundantly re-calling `propose*Step` itself once Realtime delivers
 * the resulting `trip_decisions` rows. This matters most for the
 * hotel-confirmed -> activities-proposed transition: `proposeActivitiesStep`
 * makes a real Curator LLM call, and without threading the result through
 * like this, both this server-side call *and* a naive client-side reactive
 * re-fetch would each trigger their own Curator call for the same
 * transition.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import type { ModelClient } from "@/src/agents/model-client";
import { getCurrentChainStep, type ChainStep } from "@/src/domain/chain";
import { listActiveTripDecisions } from "@/src/repositories/trip-decisions";
import type { EmbeddingClient } from "@/src/retrieval/embedding-client";
import {
  confirmActivitiesStep,
  proposeActivitiesStep,
  type ProposeActivitiesStepResult,
  type ProposedScheduledActivity,
} from "./activities-step";
import { proposeFlightStep, type ProposeFlightStepResult } from "./flight-step";
import { proposeHotelStep, type ProposeHotelStepResult } from "./hotel-step";

export interface StepwiseChainClients {
  /** Ranks activity candidates (`activities-step.ts`'s `proposeActivitiesStep`). */
  curatorModelClient: ModelClient;
  /** Writes the final itinerary prose (`activities-step.ts`'s `confirmActivitiesStep`). */
  writerModelClient: ModelClient;
  embeddingClient: EmbeddingClient;
}

export type ProposeCurrentStepResult =
  | { step: "flight"; result: ProposeFlightStepResult }
  | { step: "hotel"; result: ProposeHotelStepResult }
  | { step: "activities"; result: ProposeActivitiesStepResult }
  | { step: "complete" };

/** Proposes whichever chain step is currently active — a no-op (`{step: "complete"}`) if the chain is already complete. */
export async function proposeCurrentChainStep(
  supabase: SupabaseClient<Database>,
  tripId: string,
  clients: StepwiseChainClients,
): Promise<ProposeCurrentStepResult> {
  const step = getCurrentChainStep(await listActiveTripDecisions(supabase, tripId));
  if (step === "flight") {
    return { step: "flight", result: await proposeFlightStep(supabase, { tripId }) };
  }
  if (step === "hotel") {
    return { step: "hotel", result: await proposeHotelStep(supabase, { tripId }) };
  }
  if (step === "activities") {
    return {
      step: "activities",
      result: await proposeActivitiesStep(supabase, clients.curatorModelClient, clients.embeddingClient, { tripId }),
    };
  }
  return { step: "complete" };
}

export type ReviseChainStepResult =
  | { step: "flight"; result: ProposeFlightStepResult }
  | { step: "hotel"; result: ProposeHotelStepResult }
  | { step: "activities"; result: ProposeActivitiesStepResult };

/**
 * Re-proposes a specific step, excluding whatever it's currently confirmed
 * as (if anything) so a re-propose against unchanged requirements doesn't
 * just return the same candidate again. Never confirms anything — the user
 * picks a card from the fresh candidate list this writes (and this
 * function's own return value already carries, for the UI's direct-click
 * "Change" flow — see `app/app/actions.ts`'s `confirmCascadeAndRevise`).
 */
export async function reviseChainStep(
  supabase: SupabaseClient<Database>,
  tripId: string,
  step: ChainStep,
  clients: StepwiseChainClients,
): Promise<ReviseChainStepResult> {
  const decisions = await listActiveTripDecisions(supabase, tripId);
  const confirmedValue = (field: string) =>
    decisions.find((d) => d.field === field && d.status === "confirmed")?.value as string | undefined;

  if (step === "flight") {
    const result = await proposeFlightStep(supabase, {
      tripId,
      excludeOutboundFlightId: confirmedValue("outboundFlight"),
      excludeReturnFlightId: confirmedValue("returnFlight"),
    });
    return { step: "flight", result };
  }
  if (step === "hotel") {
    const result = await proposeHotelStep(supabase, { tripId, excludeHotelId: confirmedValue("hotel") });
    return { step: "hotel", result };
  }
  const result = await proposeActivitiesStep(supabase, clients.curatorModelClient, clients.embeddingClient, { tripId });
  return { step: "activities", result };
}

export type AdvanceOrRefreshResult = ProposeCurrentStepResult | { step: "refreshed" };

/**
 * Called by `app/app/actions.ts` right after confirming a flight or hotel
 * candidate (first-time or a revision). If the chain isn't complete yet,
 * proposes the next step so its candidates appear without a further round
 * trip — the normal forward-flow case. If the chain is (still) complete —
 * meaning this was a revision of an already-confirmed earlier step that
 * didn't invalidate what's downstream (design rules 2/3: a same-dates
 * flight swap, or any hotel change), this instead refreshes budget/
 * itineraryText by re-running `confirmActivitiesStep` with the *same*
 * already-confirmed schedule — no re-search/re-curation/re-scheduling, just
 * recomputing the two fields that actually depend on the flight/hotel's
 * price/name (the slice-3 "stale budget after a hotel-only revision" bug,
 * generalized here to a same-dates flight revision too, since flight price
 * also feeds the budget).
 */
export async function advanceOrRefreshChain(
  supabase: SupabaseClient<Database>,
  tripId: string,
  clients: StepwiseChainClients,
): Promise<AdvanceOrRefreshResult> {
  const decisions = await listActiveTripDecisions(supabase, tripId);
  if (getCurrentChainStep(decisions) !== "complete") {
    return proposeCurrentChainStep(supabase, tripId, clients);
  }
  const activitiesDecision = decisions.find((d) => d.field === "activities" && d.status === "confirmed");
  if (!activitiesDecision) return { step: "complete" };
  await confirmActivitiesStep(supabase, clients.writerModelClient, {
    tripId,
    scheduledActivities: activitiesDecision.value as unknown as ProposedScheduledActivity[],
  });
  return { step: "refreshed" };
}
