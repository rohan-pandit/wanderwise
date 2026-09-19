"use server";

/**
 * Server Action entry points for the chat UI and the stepwise chain
 * (Phase 6/7; stepwise chain redesign per `docs/IMPLEMENTATION_PLAN.md`).
 *
 * Uses the **service-role** client (`createServiceClient`), not the
 * RLS-scoped one, for everything past the auth check below. The
 * orchestrator writes to `workflow_runs`/`workflow_steps`/`agent_runs`/
 * `tool_calls`/`guardrail_events` — internal tables with RLS enabled and no
 * policy for `anon`/`authenticated` (supabase/migrations/0001_initial_schema.sql)
 * — so the RLS-scoped client would silently fail (or, for the trip-owned
 * tables that DO have policies, would just be redundant with the explicit
 * `tripId` scoping this module already does). This is exactly the "trusted
 * server-side code" `service.ts`'s own docstring describes, on the
 * condition that ownership is checked explicitly instead — see
 * `requireOwnedTrip` below, which replaces what RLS would otherwise have
 * enforced automatically.
 *
 * Slice 4 (chat UI rework, "STEPWISE CHAIN REDESIGN") replaced
 * `chain-orchestrator.ts`'s interim auto-confirm glue (deleted this slice)
 * with real per-step interaction: `propose*Candidates`/`confirm*Candidate`
 * are the hybrid UI's direct, no-LLM-round-trip pick/confirm path;
 * `sendMessage`'s auto-chain now only ever *proposes* the next step (never
 * auto-confirms), and a revision that risks invalidating already-confirmed
 * downstream work surfaces as `pendingCascadeConfirmation` for the UI to
 * show a warning and get explicit confirmation (`confirmCascadeAndRevise`)
 * before anything is retired.
 */
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/src/config/supabase/server";
import { createServiceClient } from "@/src/config/supabase/service";
import type { Database } from "@/src/config/supabase/database.types";
import { AnthropicModelClient } from "@/src/agents/providers/anthropic-model-client";
import { AGENT_MODELS } from "@/src/config/models";
import { FlightProviderError } from "@/src/repositories/flight-provider";
import { SerpApiFlightProvider } from "@/src/repositories/providers/serpapi-flight-provider";
import { VoyageEmbeddingClient } from "@/src/retrieval/providers/voyage-embedding-client";
import { getCurrentChainStep, type ChainStep } from "@/src/domain/chain";
import type { BudgetBreakdown, BudgetViolation } from "@/src/domain/budget";
import { createSession } from "@/src/repositories/sessions";
import { recordGuardrailEvent } from "@/src/repositories/guardrail-events";
import { listActiveTripDecisions } from "@/src/repositories/trip-decisions";
import { appendTripEvent } from "@/src/repositories/trip-events";
import { getLatestTripState } from "@/src/repositories/trip-state";
import { getTrip, type Trip } from "@/src/repositories/trips";
import { startTrip } from "@/src/workflow/controller";
import { advanceOrThrow } from "@/src/workflow/advance";
import { deriveCorrelationId } from "@/src/workflow/correlation";
import {
  processIntakeTurn,
  type PendingCascadeConfirmation,
  type ProcessIntakeTurnResult,
} from "@/src/workflow/intake-orchestrator";
import {
  advanceOrRefreshChain,
  reviseChainStep,
  type AdvanceOrRefreshResult,
  type ReviseChainStepResult,
  type StepwiseChainClients,
} from "@/src/workflow/step-router";
import {
  NoViableFlightCandidatesError,
  confirmFlightStep,
  proposeFlightStep,
  type ConfirmFlightStepResult,
  type ProposeFlightStepResult,
} from "@/src/workflow/flight-step";
import {
  NoViableHotelCandidatesError,
  confirmHotelStep,
  proposeHotelStep,
  type ConfirmHotelStepResult,
  type ProposeHotelStepResult,
} from "@/src/workflow/hotel-step";
import {
  ActivityNotSelectedError,
  HotelStepNotConfirmedError,
  InvalidActivitiesSelectionError,
  confirmActivitySelection as confirmActivitySelectionStep,
  finalizeActivitiesStep,
  proposeActivitiesStep,
  removeActivitySelection as removeActivitySelectionStep,
  type ConfirmActivitySelectionResult,
  type FinalizeActivitiesStepResult,
  type ProposeActivitiesStepResult,
} from "@/src/workflow/activities-step";
import type { WorkflowState } from "@/src/workflow/state-machine";
import {
  AirportAmbiguousError,
  TripCancelledError,
  UnknownAirportError,
  UnknownDestinationError,
} from "@/src/workflow/step-shared";
import { AmbiguousDestinationNameError } from "@/src/repositories/destinations";

/**
 * Shared by every Server Action here past `sendMessage`'s own trip-creation
 * path: authenticate, then load the trip and check ownership explicitly (the
 * RLS-scoped client isn't used past this point — see the module docstring).
 * Also refuses a cancelled trip by default (`cancelTrip`, below) — a
 * cancelled trip is terminal (`state-machine.ts`'s `TERMINAL_STATES`), so no
 * other action here should be able to keep mutating it. `cancelTrip` itself
 * is the one caller that opts out via `allowCancelled`, since attempting to
 * cancel an already-cancelled trip needs to reach `advanceOrThrow`'s own
 * terminal-state rejection (a clearer, typed error) rather than being
 * intercepted here first.
 */
async function requireOwnedTrip(
  supabase: SupabaseClient<Database>,
  tripId: string,
  options: { allowCancelled?: boolean } = {},
): Promise<Trip> {
  const authClient = await createClient();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();
  if (authError || !user) {
    throw new Error("Not authenticated.");
  }
  const trip = await getTrip(supabase, tripId);
  if (!trip || trip.user_id !== user.id) {
    throw new Error(`Trip ${tripId} not found.`);
  }
  if (trip.status === "cancelled" && !options.allowCancelled) {
    throw new TripCancelledError(tripId);
  }
  return trip;
}

/**
 * The real model/embedding/flight-provider clients every stepwise-chain
 * call needs — constructed once per request, not per step.
 *
 * `flightProvider` is always the live SerpAPI client here — the app never
 * falls back to seed/synthetic flight data (`docs/IMPLEMENTATION_PLAN.md`'s
 * SerpAPI-only-flights integration). Evals construct their own
 * `stepwiseChainClients()` (`evals/lib/scenario-harness.ts`) that leaves
 * `flightProvider` unset, keeping the deterministic seed-backed path they
 * depend on completely unaffected.
 */
function stepwiseChainClients(): StepwiseChainClients {
  return {
    curatorModelClient: new AnthropicModelClient(AGENT_MODELS.curator),
    writerModelClient: new AnthropicModelClient(AGENT_MODELS.itineraryWriter),
    embeddingClient: new VoyageEmbeddingClient(),
    flightProvider: new SerpApiFlightProvider(),
  };
}

/**
 * A candidate list can genuinely come up empty — e.g. a revision converts
 * "cheaper" into a `maxHotelPriceUsd` threshold below every real hotel's
 * price. That's not a bug, it's the honest outcome (design rule 3: say so,
 * don't silently substitute the nearest option) — but left as a thrown
 * error, it surfaces to the client as Next.js's generic obfuscated
 * production error ("An error occurred in the Server Components render...",
 * no usable detail) instead of an actual explanation. Recognized "no viable
 * candidates" errors get converted to a friendly message here instead of
 * propagating as an exception; anything else re-throws unchanged.
 */
function friendlyStepErrorMessage(err: unknown): string | null {
  if (err instanceof NoViableFlightCandidatesError) {
    return "No flights match your current requirements — try relaxing the budget or other constraints.";
  }
  if (err instanceof NoViableHotelCandidatesError) {
    return "No hotels match your current requirements — try relaxing the price or rating constraints.";
  }
  if (err instanceof UnknownDestinationError) {
    return "We don't have inventory for that destination yet — try a different one.";
  }
  if (err instanceof AmbiguousDestinationNameError) {
    return "More than one destination matches that name — try including the country (e.g. \"Madrid, Spain\").";
  }
  if (err instanceof UnknownAirportError) {
    return "We couldn't find a commercial airport for that city — try a nearby major city instead.";
  }
  if (err instanceof AirportAmbiguousError) {
    // Should never actually happen live — `checkAirportReadiness` gates
    // `requirements_ready` on this being resolved first — but a friendly
    // fallback is cheap insurance against the "still ambiguous" bug case
    // surfacing as Next's generic obfuscated error instead.
    return "Which airport to search wasn't fully resolved — try asking again, naming the specific airport.";
  }
  if (err instanceof FlightProviderError) {
    // TEMPORARY DIAGNOSTIC (2026-09-18) — surfacing the real message instead
    // of the normal friendly text, to read the raw-response diagnostic
    // thrown in serpapi-flight-provider.ts without Vercel server-log access.
    // Revert alongside that diagnostic once root-caused.
    return `DIAGNOSTIC: ${err.message}`;
  }
  if (err instanceof HotelStepNotConfirmedError) {
    return "Confirm a hotel first — activities aren't ready to search yet.";
  }
  if (err instanceof InvalidActivitiesSelectionError) {
    return "That activity selection didn't go through — try again.";
  }
  if (err instanceof ActivityNotSelectedError) {
    // Not really an error the user caused — a double-click racing itself,
    // or a stale UI state after a reload. Friendly rather than a raw throw.
    return "That activity wasn't in your itinerary — it may have already been removed.";
  }
  if (err instanceof TripCancelledError) {
    return "This trip has been cancelled — start a new one to keep planning.";
  }
  return null;
}

export interface StepActionError {
  error: string;
}

export interface SendMessageInput {
  /** Omit to start a new trip (and its session) for this message. */
  tripId?: string;
  message: string;
  /**
   * Client-generated idempotency key for starting a new trip, required only
   * when `tripId` is omitted. `ChatPanel` generates one once per compose
   * attempt and reuses it across retries of that same attempt, so a lost
   * response followed by a retry (or a network-level resend) resolves to
   * the same trip instead of creating a second, orphaned one — see
   * `startTrip`'s docstring (`src/workflow/controller.ts`).
   */
  startCorrelationId?: string;
  /**
   * Client-generated idempotency key for this turn's chat-message writes
   * (`processIntakeTurn`'s `appendMessageOnce`, `src/workflow/intake-orchestrator.ts`)
   * — a fresh one per send attempt, so a retried turn doesn't show the same
   * chat bubble twice. Doesn't prevent the LLM call itself from re-running
   * on a genuine retry (a real, separately-costed event, left to record as
   * such rather than hidden from the cost/observability dashboards).
   */
  turnCorrelationId?: string;
}

export interface SendMessageResult extends ProcessIntakeTurnResult {
  tripId: string;
  sessionId: string;
}

/**
 * Only `TripCancelledError` gets the `{error}` treatment here — an honest,
 * expected outcome of a real user action (clicking "Cancel trip" in one tab,
 * then continuing to type in another) that deserves a clear message, not a
 * thrown exception. Live-verified this surfaces as React/Next's generic
 * obfuscated production error otherwise (same class of gap
 * `friendlyStepErrorMessage` already exists to prevent for the other
 * actions) — "Trip not found"/auth failures stay thrown, unchanged, since
 * those aren't reachable through normal use the way a cancelled trip is.
 */
export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult | StepActionError> {
  const authClient = await createClient();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();
  if (authError || !user) {
    throw new Error("Not authenticated.");
  }

  const supabase = createServiceClient();
  let tripId = input.tripId;
  let sessionId: string;

  if (tripId) {
    const trip = await getTrip(supabase, tripId);
    if (!trip || trip.user_id !== user.id) {
      throw new Error(`Trip ${tripId} not found.`);
    }
    if (trip.status === "cancelled") {
      return { error: "This trip has been cancelled — start a new one to keep planning." };
    }
    sessionId = trip.session_id;
  } else {
    const session = await createSession(supabase, user.id);
    const { trip } = await startTrip(supabase, {
      sessionId: session.id,
      userId: user.id,
      correlationId: input.startCorrelationId,
    });
    tripId = trip.id;
    sessionId = trip.session_id;
  }

  const modelClient = new AnthropicModelClient(AGENT_MODELS.intake);
  const result = await processIntakeTurn(supabase, modelClient, {
    tripId,
    sessionId,
    userMessage: input.message,
    correlationId: input.turnCorrelationId,
    // Always on: the app's flight search is SerpAPI-only (see
    // `stepwiseChainClients()` below), which needs a real airport code, not
    // just a city name. Evals' own `processIntakeTurn` calls leave this off
    // — the seed-backed path they use has no airport concept at all.
    enableAirportDisambiguation: true,
  });

  // Auto-chain a chat-requested revision, scheduled via `after()` so this
  // response returns immediately (the user's message + the intake agent's
  // own reply) instead of blocking on a real API call; the itinerary panel
  // watches `trip_decisions`/`trip_events` via Supabase Realtime to see the
  // result land live. Unlike the old interim glue (`chain-orchestrator.ts`,
  // deleted this slice), nothing here auto-confirms anything — it only ever
  // proposes, and the user picks/confirms via the hybrid UI's own Server
  // Actions below.
  //
  // The cold-start case (`workflowState === "requirements_ready"` with no
  // decisions yet — the chain's very first propose) deliberately has no
  // equivalent trigger here. It used to: an `after()` block symmetrical to
  // the one below, proposing the current chain step the moment requirements
  // first became ready. That raced the itinerary panel's own `useEffect`
  // (`itinerary-panel.tsx`), which independently calls `proposeFlightCandidates`
  // the moment it observes `activeStep === "flight" && requirementsReady` on
  // its next render — both landed for the same trip, and since
  // `proposeFlightStep` isn't idempotent (each call unconditionally retires
  // whatever "proposed" rows exist and inserts a fresh set), whichever call's
  // writes landed second silently superseded the first mid-render, doubling
  // live SerpAPI usage and occasionally showing a transient "no flights"
  // state that self-repaired once the second wave of writes arrived. Every
  // *other* transition avoids this by having exactly one synchronous trigger
  // (`advanceOrRefreshChain`, called from `confirmFlightCandidate`/
  // `confirmHotelCandidate` below) that pre-arms the client's guard ref from
  // its own already-known result before Realtime can double-fire it — the
  // client's reactive effect alone is a complete, self-sufficient trigger for
  // the cold-start case too, so the fix is to not have a second one racing
  // it, not to add locking.
  const finalTripId = tripId;
  if (result.pendingCascadeConfirmation) {
    // Do nothing yet — the UI must show the warning (from
    // `result.pendingCascadeConfirmation`) and the user must explicitly
    // confirm via `confirmCascadeAndRevise` before any re-propose/retirement
    // happens. The requirement/decision value this turn resolved to, if
    // any, is already persisted regardless (see `applyRevisionProposal`'s
    // docstring in `intake-orchestrator.ts`).
  } else if (result.decisionRevisionRequested) {
    const step = result.decisionRevisionRequested.step;
    after(() =>
      reviseChainStep(supabase, finalTripId, step, stepwiseChainClients()).catch(async (err) => {
        console.error(`reviseChainStep failed for trip ${finalTripId}:`, err);
        // Fire-and-forget: nothing is waiting on this promise's rejection, so
        // the failure needs its own signal for the itinerary panel to pick up
        // (via Realtime) rather than being silently swallowed — the honest-
        // failure gap the direct propose*/confirmCascadeAndRevise paths above
        // already close with `friendlyStepErrorMessage`+`{error}` returns.
        const friendly = friendlyStepErrorMessage(err) ?? "That change didn't go through — try again or adjust your requirements.";
        await appendTripEvent(supabase, {
          tripId: finalTripId,
          eventType: "chain_revision_failed",
          payload: { step, message: friendly },
          correlationId: deriveCorrelationId(finalTripId, `chain_revision_failed:${step}`),
        }).catch((logErr) => console.error(`failed to log chain_revision_failed event for trip ${finalTripId}:`, logErr));
      }),
    );
  }

  return { ...result, tripId, sessionId };
}

export interface ProposeFlightCandidatesInput {
  tripId: string;
}

export async function proposeFlightCandidates(input: ProposeFlightCandidatesInput): Promise<ProposeFlightStepResult | StepActionError> {
  const supabase = createServiceClient();
  await requireOwnedTrip(supabase, input.tripId);
  try {
    return await proposeFlightStep(supabase, { tripId: input.tripId });
  } catch (err) {
    const friendly = friendlyStepErrorMessage(err);
    if (friendly) return { error: friendly };
    throw err;
  }
}

export interface ConfirmFlightCandidateInput {
  tripId: string;
  outboundFlightId: string;
  returnFlightId: string;
}

export interface ConfirmFlightCandidateResult {
  confirmed: ConfirmFlightStepResult;
  /** Whatever `advanceOrRefreshChain` did next — the client uses this directly to populate the following step's candidates rather than redundantly re-fetching once Realtime delivers the same rows. */
  next: AdvanceOrRefreshResult;
}

/** Confirms the user's picked flight pair, then either proposes the next step (first-time) or refreshes budget/itineraryText (a revision that left the rest of the chain confirmed) — see `step-router.ts`'s `advanceOrRefreshChain`. */
export async function confirmFlightCandidate(input: ConfirmFlightCandidateInput): Promise<ConfirmFlightCandidateResult | StepActionError> {
  const supabase = createServiceClient();
  await requireOwnedTrip(supabase, input.tripId);
  const confirmed = await confirmFlightStep(supabase, {
    tripId: input.tripId,
    outboundFlightId: input.outboundFlightId,
    returnFlightId: input.returnFlightId,
  });
  try {
    const next = await advanceOrRefreshChain(supabase, input.tripId, stepwiseChainClients());
    return { confirmed, next };
  } catch (err) {
    const friendly = friendlyStepErrorMessage(err);
    if (friendly) return { error: friendly };
    throw err;
  }
}

export interface ProposeHotelCandidatesInput {
  tripId: string;
}

export async function proposeHotelCandidates(input: ProposeHotelCandidatesInput): Promise<ProposeHotelStepResult | StepActionError> {
  const supabase = createServiceClient();
  await requireOwnedTrip(supabase, input.tripId);
  try {
    return await proposeHotelStep(supabase, { tripId: input.tripId });
  } catch (err) {
    const friendly = friendlyStepErrorMessage(err);
    if (friendly) return { error: friendly };
    throw err;
  }
}

export interface ConfirmHotelCandidateInput {
  tripId: string;
  hotelId: string;
}

export interface ConfirmHotelCandidateResult {
  confirmed: ConfirmHotelStepResult;
  /** Whatever `advanceOrRefreshChain` did next — critically, when this is `{step: "activities", result}`, the client must use `result` directly rather than also re-fetching, since `proposeActivitiesStep` makes a real Curator LLM call it shouldn't pay for twice. */
  next: AdvanceOrRefreshResult;
}

export async function confirmHotelCandidate(input: ConfirmHotelCandidateInput): Promise<ConfirmHotelCandidateResult | StepActionError> {
  const supabase = createServiceClient();
  await requireOwnedTrip(supabase, input.tripId);
  const confirmed = await confirmHotelStep(supabase, { tripId: input.tripId, hotelId: input.hotelId });
  try {
    const next = await advanceOrRefreshChain(supabase, input.tripId, stepwiseChainClients());
    return { confirmed, next };
  } catch (err) {
    const friendly = friendlyStepErrorMessage(err);
    if (friendly) return { error: friendly };
    throw err;
  }
}

export interface ProposeActivityCandidatesInput {
  tripId: string;
  /** Category chips selected in the UI preference form (`activities.category` values) — see `proposeActivitiesStep`'s own docstring. */
  categories?: string[];
  /** Optional free-text supplement from the same form. */
  criteria?: string;
}

/** The UI-driven activity-preference form's submit action (`docs/IMPLEMENTATION_PLAN.md`'s "ACTIVITIES: PREFERENCE-DRIVEN MULTI-SELECT" redesign) — retrieves+curates candidates for the given preference, ranked, with real names/categories/prices. Not scheduled yet; the user picks via `confirmActivitySelection` below. */
export async function proposeActivityCandidates(
  input: ProposeActivityCandidatesInput,
): Promise<ProposeActivitiesStepResult | StepActionError> {
  const supabase = createServiceClient();
  await requireOwnedTrip(supabase, input.tripId);
  const clients = stepwiseChainClients();
  try {
    return await proposeActivitiesStep(supabase, clients.curatorModelClient, clients.embeddingClient, {
      tripId: input.tripId,
      categories: input.categories,
      criteria: input.criteria,
    });
  } catch (err) {
    const friendly = friendlyStepErrorMessage(err);
    if (friendly) return { error: friendly };
    throw err;
  }
}

export interface ConfirmActivitySelectionInput {
  tripId: string;
  activityId: string;
}

/** Adds one activity to the trip (see `confirmActivitySelection`'s own docstring, `activities-step.ts`) — the multi-select equivalent of `confirmFlightCandidate`/`confirmHotelCandidate`, callable as many times as the user wants to add activities. */
export async function confirmActivitySelection(
  input: ConfirmActivitySelectionInput,
): Promise<ConfirmActivitySelectionResult | StepActionError> {
  const supabase = createServiceClient();
  await requireOwnedTrip(supabase, input.tripId);
  try {
    return await confirmActivitySelectionStep(supabase, { tripId: input.tripId, activityId: input.activityId });
  } catch (err) {
    const friendly = friendlyStepErrorMessage(err);
    if (friendly) return { error: friendly };
    throw err;
  }
}

export interface RemoveActivitySelectionInput {
  tripId: string;
  activityId: string;
}

/** The inverse of `confirmActivitySelection` — removes one previously-added activity. */
export async function removeActivitySelection(input: RemoveActivitySelectionInput): Promise<{ ok: true } | StepActionError> {
  const supabase = createServiceClient();
  await requireOwnedTrip(supabase, input.tripId);
  try {
    await removeActivitySelectionStep(supabase, { tripId: input.tripId, activityId: input.activityId });
    return { ok: true };
  } catch (err) {
    const friendly = friendlyStepErrorMessage(err);
    if (friendly) return { error: friendly };
    throw err;
  }
}

export interface FinalizeActivitiesInput {
  tripId: string;
}

/** Schedules every currently-selected activity, computes budget/itineraryText (activities is the chain's last step), then fires the one-time `chain_completed` transition if the whole chain is now confirmed — idempotent, and skipped if the trip has already moved past `requirements_ready` (e.g. a later re-finalize after finalization). */
export async function finalizeActivities(input: FinalizeActivitiesInput): Promise<FinalizeActivitiesStepResult | StepActionError> {
  const supabase = createServiceClient();
  await requireOwnedTrip(supabase, input.tripId);
  const clients = stepwiseChainClients();
  try {
    const result = await finalizeActivitiesStep(supabase, clients.writerModelClient, { tripId: input.tripId });

    const decisions = await listActiveTripDecisions(supabase, input.tripId);
    if (getCurrentChainStep(decisions) === "complete") {
      const currentState = await getLatestTripState(supabase, input.tripId);
      if (currentState?.state.workflowState === "requirements_ready") {
        await advanceOrThrow(supabase, {
          tripId: input.tripId,
          event: "chain_completed",
          actor: "system",
          correlationId: deriveCorrelationId(input.tripId, "chain_completed"),
          agentName: "activities_step",
        });
      }
    }

    return result;
  } catch (err) {
    const friendly = friendlyStepErrorMessage(err);
    if (friendly) return { error: friendly };
    throw err;
  }
}

export interface ConfirmCascadeAndReviseInput {
  tripId: string;
  step: ChainStep;
}

/**
 * The user's explicit "yes, go ahead" after `pendingCascadeConfirmation`
 * warned that revising an already-confirmed earlier step may invalidate
 * what's downstream — and also the direct "Change" click for revising a
 * step that *doesn't* risk any confirmed downstream work (no warning
 * needed there, but the re-propose mechanics are identical either way, so
 * both UI paths call this same action). Only fires the re-propose — the
 * requirement/decision value itself was already persisted the turn it was
 * requested (see `sendMessage`'s docstring). Returns the fresh candidates
 * directly so the client can render them without a further round trip.
 */
export async function confirmCascadeAndRevise(input: ConfirmCascadeAndReviseInput): Promise<ReviseChainStepResult | StepActionError> {
  const supabase = createServiceClient();
  await requireOwnedTrip(supabase, input.tripId);
  try {
    return await reviseChainStep(supabase, input.tripId, input.step, stepwiseChainClients());
  } catch (err) {
    const friendly = friendlyStepErrorMessage(err);
    if (friendly) return { error: friendly };
    throw err;
  }
}

export interface FinalizeTripInput {
  tripId: string;
  /** Set once the user has explicitly acknowledged a CEILING_EXCEEDED budget violation (PROJECT_BRIEF.md §9.3: "cannot be exceeded without explicit user override"). Ignored when there's no violation to override. */
  overrideBudgetCeiling?: boolean;
}

export interface FinalizeTripResult {
  tripId: string;
  workflowState: WorkflowState;
}

/** Returned instead of `FinalizeTripResult` when the confirmed budget exceeds its ceiling and the caller hasn't set `overrideBudgetCeiling` yet — the UI's cue to show the violation and ask for explicit confirmation before retrying. */
export interface FinalizeTripBudgetOverrideRequired {
  requiresBudgetOverride: true;
  violations: BudgetViolation[];
}

/**
 * Explicitly finalizes a trip once all three chain steps are confirmed —
 * the stepwise model's replacement for the old one-shot pipeline's
 * `presenting_draft` -> `awaiting_confirmation` -> `finalized` flow, reusing
 * those same existing transition rules (`state-machine.ts`) rather than
 * inventing new ones, entered via a new direct `chain_completed` event from
 * `requirements_ready` instead of marching through the now-unused
 * `searching_inventory`/`validating_candidates`/etc. states the stepwise
 * steps never touch. `proposalHashMatches` is passed `true` unconditionally
 * — no equivalent of the old model's single draft-proposal hash exists
 * here, and every constituent decision already re-validates its own hard
 * constraints/feasibility at its own confirm time; a real proposal-hash
 * mechanism for finalize is out of scope for this slice.
 *
 * `guardrailsPassed` is no longer an unconditional `true` — it's computed
 * from the confirmed `budget` decision's own `violations` (§9.1's
 * budget-ceiling guardrail, previously computed but never actually checked
 * here, tracked in `docs/IMPLEMENTATION_PLAN.md` §5). If more finalize-time
 * guardrails are added later, this is the natural place to aggregate them
 * rather than tying `guardrailsPassed` to just this one check.
 */
export async function finalizeTrip(
  input: FinalizeTripInput,
): Promise<FinalizeTripResult | FinalizeTripBudgetOverrideRequired> {
  const supabase = createServiceClient();
  await requireOwnedTrip(supabase, input.tripId);

  const decisions = await listActiveTripDecisions(supabase, input.tripId);
  if (getCurrentChainStep(decisions) !== "complete") {
    throw new Error(`Trip ${input.tripId} can't be finalized yet — not every step is confirmed.`);
  }

  const budget = decisions.find((d) => d.field === "budget" && d.status === "confirmed")?.value as
    | BudgetBreakdown
    | undefined;
  const violations = budget?.violations ?? [];
  const overridden = violations.length > 0 && input.overrideBudgetCeiling === true;

  await recordGuardrailEvent(supabase, {
    tripId: input.tripId,
    agentName: "finalize_trip",
    guardrailName: "budget_ceiling_at_finalize",
    layer: "domain_validation",
    triggered: violations.length > 0,
    detail:
      violations.length > 0
        ? `${violations.map((v) => v.message).join("; ")}${overridden ? " (user override confirmed)" : ""}`
        : null,
  });

  if (violations.length > 0 && !overridden) {
    return { requiresBudgetOverride: true, violations };
  }

  await advanceOrThrow(supabase, {
    tripId: input.tripId,
    event: "confirmation_requested",
    actor: "user",
    correlationId: deriveCorrelationId(input.tripId, "confirmation_requested"),
    agentName: "finalize_trip",
  });
  const workflowState = await advanceOrThrow(supabase, {
    tripId: input.tripId,
    event: "user_confirmed",
    actor: "user",
    proposalHashMatches: true,
    guardrailsPassed: true,
    correlationId: deriveCorrelationId(input.tripId, "user_confirmed"),
    agentName: "finalize_trip",
  });

  return { tripId: input.tripId, workflowState };
}

export interface CancelTripInput {
  tripId: string;
}

export interface CancelTripResult {
  tripId: string;
  workflowState: WorkflowState;
}

/**
 * Marks a trip cancelled (PROJECT_BRIEF.md §19 #13) — for a user who wants
 * to abandon a trip that's still being planned (nothing is ever booked in
 * this app, in any version, so there's no reservation to actually cancel;
 * this is about the *planning session* itself, which could otherwise sit
 * indefinitely in whatever partial state it was left in, indistinguishable
 * from "still active" in the trip history list). Reuses `state-machine.ts`'s
 * existing `cancel` event, legal from any non-terminal state — no new
 * workflow-state plumbing needed, just a real caller for a transition that
 * was previously only reachable from unit tests.
 */
export async function cancelTrip(input: CancelTripInput): Promise<CancelTripResult> {
  const supabase = createServiceClient();
  await requireOwnedTrip(supabase, input.tripId, { allowCancelled: true });

  const workflowState = await advanceOrThrow(supabase, {
    tripId: input.tripId,
    event: "cancel",
    actor: "user",
    correlationId: deriveCorrelationId(input.tripId, "cancel"),
    agentName: "cancel_trip",
  });

  return { tripId: input.tripId, workflowState };
}

export type { PendingCascadeConfirmation };
