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
  proposeCurrentChainStep,
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
  confirmActivitiesStep,
  proposeActivitiesStep,
  type ConfirmActivitiesStepResult,
  type ProposeActivitiesStepResult,
  type ProposedScheduledActivity,
} from "@/src/workflow/activities-step";
import type { WorkflowState } from "@/src/workflow/state-machine";
import { UnknownDestinationError } from "@/src/workflow/step-shared";
import { AmbiguousDestinationNameError } from "@/src/repositories/destinations";

/** Shared by every Server Action here past `sendMessage`'s own trip-creation path: authenticate, then load the trip and check ownership explicitly (the RLS-scoped client isn't used past this point — see the module docstring). */
async function requireOwnedTrip(supabase: SupabaseClient<Database>, tripId: string): Promise<Trip> {
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
  return trip;
}

/** The real model/embedding clients every stepwise-chain call needs — constructed once per request, not per step. */
function stepwiseChainClients(): StepwiseChainClients {
  return {
    curatorModelClient: new AnthropicModelClient(AGENT_MODELS.curator),
    writerModelClient: new AnthropicModelClient(AGENT_MODELS.itineraryWriter),
    embeddingClient: new VoyageEmbeddingClient(),
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
    return "Something went wrong matching your destination — please try again.";
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

export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
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
  });

  // Auto-chain into whatever's next, scheduled via `after()` so this
  // response returns immediately (the user's message + the intake agent's
  // own reply) instead of blocking on real API calls; the itinerary panel
  // watches `trip_decisions`/`trip_events` via Supabase Realtime to see the
  // rest land live. Unlike the old interim glue (`chain-orchestrator.ts`,
  // deleted this slice), nothing here auto-confirms anything — it only ever
  // proposes, and the user picks/confirms via the hybrid UI's own Server
  // Actions below.
  //
  // Checked in this exact order — `pendingCascadeConfirmation` and
  // `decisionRevisionRequested` first, `workflowState` last. Caught live in
  // slice 3 (not by unit tests, which mock `processIntakeTurn` and so never
  // see this): `workflowState` never leaves `"requirements_ready"` once the
  // stepwise steps take over (they deliberately never call `advanceTrip`),
  // so checking it first would mean a genuine chat-requested revision is
  // silently missed forever in favor of the "requirements_ready" branch.
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
  } else if (result.workflowState === "requirements_ready") {
    // Only propose the very first time the chain has nothing at all yet —
    // `workflowState` stays "requirements_ready" on every later turn too,
    // and without this check an unrelated chat message would keep
    // re-searching and overwriting the current step's candidate list.
    const existingDecisions = await listActiveTripDecisions(supabase, finalTripId);
    if (existingDecisions.length === 0) {
      after(() =>
        proposeCurrentChainStep(supabase, finalTripId, stepwiseChainClients()).catch(async (err) => {
          console.error(`proposeCurrentChainStep failed for trip ${finalTripId}:`, err);
          // Fire-and-forget, same reasoning as the `reviseChainStep` failure
          // handling above: nothing is waiting on this rejection, so the
          // failure needs its own signal (a `chain_propose_failed` trip_event,
          // picked up by the itinerary panel's `needsAttention` Realtime
          // listener) instead of leaving the UI stuck with no explanation.
          const step = getCurrentChainStep(await listActiveTripDecisions(supabase, finalTripId));
          const friendly = friendlyStepErrorMessage(err) ?? "That didn't go through — try again or adjust your requirements.";
          await appendTripEvent(supabase, {
            tripId: finalTripId,
            eventType: "chain_propose_failed",
            payload: { step, message: friendly },
            correlationId: deriveCorrelationId(finalTripId, `chain_propose_failed:${step}`),
          }).catch((logErr) => console.error(`failed to log chain_propose_failed event for trip ${finalTripId}:`, logErr));
        }),
      );
    }
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

export interface ProposeActivitiesCandidateInput {
  tripId: string;
}

export async function proposeActivitiesCandidate(input: ProposeActivitiesCandidateInput): Promise<ProposeActivitiesStepResult> {
  const supabase = createServiceClient();
  await requireOwnedTrip(supabase, input.tripId);
  const clients = stepwiseChainClients();
  return proposeActivitiesStep(supabase, clients.curatorModelClient, clients.embeddingClient, { tripId: input.tripId });
}

export interface ConfirmActivitiesCandidateInput {
  tripId: string;
  scheduledActivities: ProposedScheduledActivity[];
}

/** Confirms the schedule (activities is the chain's last step, so this also computes budget/itineraryText), then fires the one-time `chain_completed` transition if the whole chain is now confirmed — idempotent, and skipped if the trip has already moved past `requirements_ready` (e.g. a later re-confirm after finalization). */
export async function confirmActivitiesCandidate(input: ConfirmActivitiesCandidateInput): Promise<ConfirmActivitiesStepResult> {
  const supabase = createServiceClient();
  await requireOwnedTrip(supabase, input.tripId);
  const clients = stepwiseChainClients();
  const result = await confirmActivitiesStep(supabase, clients.writerModelClient, {
    tripId: input.tripId,
    scheduledActivities: input.scheduledActivities,
  });

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

export type { PendingCascadeConfirmation };
