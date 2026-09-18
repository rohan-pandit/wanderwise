/**
 * Real per-step propose routing for the stepwise chain redesign
 * (`docs/IMPLEMENTATION_PLAN.md`'s "STEPWISE CHAIN REDESIGN" section),
 * slice 4. Replaces `chain-orchestrator.ts`'s interim auto-confirm glue
 * (deleted this slice) — this module only ever *proposes*, deliberately
 * dropping the old module's auto-confirm-the-top-pick behavior. The user
 * confirms a specific candidate via a Server Action (`app/app/actions.ts`'s
 * `confirm*Candidate` functions), which call `flight-step.ts`/
 * `hotel-step.ts`'s `confirm*Step` directly — this module never calls
 * either of those.
 *
 * `proposeCurrentChainStep`/`advanceOrRefreshChain` return what they did
 * (which step, with what candidates) rather than `void` — the itinerary
 * panel consumes this directly to populate its candidate-card state, rather
 * than redundantly re-calling `propose*Step` itself once Realtime delivers
 * the resulting `trip_decisions` rows.
 *
 * Activities is the one step this module doesn't route propose calls for
 * (`docs/IMPLEMENTATION_PLAN.md`'s "ACTIVITIES: PREFERENCE-DRIVEN
 * MULTI-SELECT" redesign) — `proposeActivitiesStep` now needs a real
 * user-submitted preference that doesn't exist at the moment hotel
 * confirms, so `proposeCurrentChainStep` just signals `{step: "activities"}`
 * with no candidates; `app/app/actions.ts`'s `proposeActivityCandidates`
 * calls `proposeActivitiesStep`/`confirmActivitySelection` directly once the
 * user submits the preference form, bypassing this module entirely. This
 * module still calls `finalizeActivitiesStep` (the chain's terminal step) —
 * see `advanceOrRefreshChain` below.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import type { ModelClient } from "@/src/agents/model-client";
import { getCurrentChainStep, type ChainStep } from "@/src/domain/chain";
import type { FlightSearchProvider } from "@/src/repositories/flight-provider";
import { listActiveTripDecisions } from "@/src/repositories/trip-decisions";
import type { EmbeddingClient } from "@/src/retrieval/embedding-client";
import { finalizeActivitiesStep } from "./activities-step";
import { proposeFlightStep, type ProposeFlightStepResult } from "./flight-step";
import { proposeHotelStep, type ProposeHotelStepResult } from "./hotel-step";

export interface StepwiseChainClients {
  /** Ranks activity candidates — used directly by `app/app/actions.ts`'s `proposeActivityCandidates` (`activities-step.ts`'s `proposeActivitiesStep`), not by this module. */
  curatorModelClient: ModelClient;
  /** Writes the final itinerary prose (`activities-step.ts`'s `finalizeActivitiesStep`). */
  writerModelClient: ModelClient;
  /** Used directly by `app/app/actions.ts`'s `proposeActivityCandidates`, not by this module. */
  embeddingClient: EmbeddingClient;
  /** Passed straight through to `proposeFlightStep`'s own `flightProvider` — see that param's docstring (`flight-step.ts`). Unset for evals (the seed-backed path); the real app's `stepwiseChainClients()` (`app/app/actions.ts`) always sets it. */
  flightProvider?: FlightSearchProvider;
}

export type ProposeCurrentStepResult =
  | { step: "flight"; result: ProposeFlightStepResult }
  | { step: "hotel"; result: ProposeHotelStepResult }
  /**
   * No `result` — unlike flight/hotel, activities can't be auto-proposed the
   * moment it becomes the active step: `proposeActivitiesStep` now needs a
   * real user-submitted preference (category chips + optional free text,
   * `docs/IMPLEMENTATION_PLAN.md`'s "ACTIVITIES: PREFERENCE-DRIVEN
   * MULTI-SELECT" redesign) that doesn't exist yet at the moment hotel just
   * confirmed. This just signals "it's activities' turn" so the UI shows the
   * preference form; the client calls `proposeActivityCandidates`
   * (`app/app/actions.ts`) directly once the user submits it.
   */
  | { step: "activities" }
  | { step: "complete" };

/** Proposes whichever chain step is currently active — a no-op (`{step: "complete"}`) if the chain is already complete. */
export async function proposeCurrentChainStep(
  supabase: SupabaseClient<Database>,
  tripId: string,
  clients: StepwiseChainClients,
): Promise<ProposeCurrentStepResult> {
  const step = getCurrentChainStep(await listActiveTripDecisions(supabase, tripId));
  if (step === "flight") {
    return { step: "flight", result: await proposeFlightStep(supabase, { tripId, flightProvider: clients.flightProvider }) };
  }
  if (step === "hotel") {
    return { step: "hotel", result: await proposeHotelStep(supabase, { tripId }) };
  }
  if (step === "activities") {
    return { step: "activities" };
  }
  return { step: "complete" };
}

export type ReviseChainStepResult =
  | { step: "flight"; result: ProposeFlightStepResult }
  | { step: "hotel"; result: ProposeHotelStepResult };

/**
 * Re-proposes a specific step, excluding whatever it's currently confirmed
 * as (if anything) so a re-propose against unchanged requirements doesn't
 * just return the same candidate again. Never confirms anything — the user
 * picks a card from the fresh candidate list this writes (and this
 * function's own return value already carries, for the UI's direct-click
 * "Change" flow — see `app/app/actions.ts`'s `confirmCascadeAndRevise`).
 *
 * Never called with `step: "activities"` — `REVISABLE_CHAIN_STEPS`
 * (`step-shared.ts`) excludes it, since activities revision is UI-driven
 * (re-submit the preference form, `proposeActivitiesStep` directly) rather
 * than chat-driven like flight/hotel. Throws rather than silently
 * proposing with no preferences if that invariant is ever violated.
 */
export async function reviseChainStep(
  supabase: SupabaseClient<Database>,
  tripId: string,
  step: ChainStep,
  clients: StepwiseChainClients,
): Promise<ReviseChainStepResult> {
  const decisions = await listActiveTripDecisions(supabase, tripId);
  const confirmedValue = (field: string) =>
    decisions.find((d) => d.status === "confirmed" && d.field === field)?.value as string | undefined;

  if (step === "flight") {
    const result = await proposeFlightStep(supabase, {
      tripId,
      excludeOutboundFlightId: confirmedValue("outboundFlight"),
      excludeReturnFlightId: confirmedValue("returnFlight"),
      flightProvider: clients.flightProvider,
    });
    return { step: "flight", result };
  }
  if (step === "hotel") {
    const result = await proposeHotelStep(supabase, { tripId, excludeHotelId: confirmedValue("hotel") });
    return { step: "hotel", result };
  }
  throw new Error(`reviseChainStep: "activities" isn't chat-revisable — this should be unreachable (trip ${tripId}).`);
}

export type AdvanceOrRefreshResult = ProposeCurrentStepResult | { step: "refreshed" };

/**
 * Called by `app/app/actions.ts` right after confirming a flight or hotel
 * candidate (first-time or a revision). If the chain isn't complete yet,
 * proposes the next step so its candidates appear without a further round
 * trip — the normal forward-flow case. If the chain is (still) complete —
 * meaning this was a revision of an already-confirmed earlier step that
 * didn't invalidate what's downstream (design rules 2/3: a same-dates
 * flight swap, or any hotel change), this instead re-runs
 * `finalizeActivitiesStep` — which re-schedules the *same already-confirmed
 * `"activity"` picks* against the (possibly-shifted) flight/hotel dates and
 * recomputes budget/itineraryText, rather than reusing stale date/time slots
 * from the old schedule (the slice-3 "stale budget after a hotel-only
 * revision" bug, generalized here to a same-dates flight revision too,
 * since flight price also feeds the budget).
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
  await finalizeActivitiesStep(supabase, clients.writerModelClient, { tripId });
  return { step: "refreshed" };
}
