"use server";

/**
 * Server Action entry point for the Intake orchestrator (Phase 6). No chat
 * UI consumes this yet — that's Phase 7 — but this makes the wiring
 * genuinely reachable through the real Next.js request path (authenticated
 * Supabase client, real Anthropic calls), not just exercised by mocked
 * unit tests. A future chat UI calls `sendMessage` directly as a Server
 * Action, or a Route Handler wraps it if a non-Server-Component client ever
 * needs it over HTTP.
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
 * condition that ownership is checked explicitly instead — see the
 * `trip.user_id !== user.id` check below, which replaces what RLS would
 * otherwise have enforced automatically.
 */
import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/src/config/supabase/server";
import { createServiceClient } from "@/src/config/supabase/service";
import type { Database } from "@/src/config/supabase/database.types";
import { AnthropicModelClient } from "@/src/agents/providers/anthropic-model-client";
import { AGENT_MODELS } from "@/src/config/models";
import { VoyageEmbeddingClient } from "@/src/retrieval/providers/voyage-embedding-client";
import { createSession } from "@/src/repositories/sessions";
import { getTrip, type Trip } from "@/src/repositories/trips";
import { startTrip } from "@/src/workflow/controller";
import { processIntakeTurn, type ProcessIntakeTurnResult } from "@/src/workflow/intake-orchestrator";
import {
  runStepwiseChain,
  runStepwiseRevision,
  type RunStepwiseChainResult,
  type StepwiseChainClients,
} from "@/src/workflow/chain-orchestrator";
import type { RevisableDecisionField } from "@/src/workflow/step-shared";

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

export interface SendMessageInput {
  /** Omit to start a new trip (and its session) for this message. */
  tripId?: string;
  message: string;
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
    const { trip } = await startTrip(supabase, { sessionId: session.id, userId: user.id });
    tripId = trip.id;
    sessionId = session.id;
  }

  const modelClient = new AnthropicModelClient(AGENT_MODELS.intake);
  const result = await processIntakeTurn(supabase, modelClient, {
    tripId,
    sessionId,
    userMessage: input.message,
  });

  // Auto-chain into whatever's next (Phase 7, decided with the user): there's
  // no user-facing checkpoint between "requirements just became ready" (or "a
  // decision revision was requested") and the resulting draft — those
  // intermediate workflow states exist for retry/telemetry granularity, not
  // because a chat UI should ever pause and ask before continuing. Scheduled
  // via `after()` so this response returns immediately (the user's message +
  // the intake agent's own reply) instead of blocking on several more
  // seconds of real API calls; the chat UI watches `trip_decisions`/
  // `trip_events` via Supabase Realtime to see the rest land live, piece by
  // piece, exactly as each step's write completes.
  //
  // `runStepwiseChain`/`runStepwiseRevision` (stepwise chain redesign slice
  // 3, `docs/IMPLEMENTATION_PLAN.md`) are interim glue: they auto-confirm
  // each step's top-ranked candidate rather than showing it and waiting for
  // the user, so the chat UI keeps behaving as it did under the old
  // one-shot pipeline (retired this slice) until slice 4 replaces this with
  // real per-step interaction.
  //
  // `decisionRevisionRequested` is checked *first*, not `workflowState`.
  // Caught live (not by unit tests, which mock `processIntakeTurn` and so
  // never see this): under the old pipeline, `workflowState` genuinely left
  // `"requirements_ready"` once search began (`advanceTrip` moved it along).
  // The new stepwise steps deliberately never call `advanceTrip` (slice 1's
  // decision), so `workflowState` stays `"requirements_ready"` forever after
  // the first run — checking it first meant a revision turn always
  // re-entered `runStepwiseChain` (which correctly no-ops once the chain is
  // already complete) instead of ever reaching `runStepwiseRevision`, so no
  // chat-requested revision could ever actually apply. `runStepwiseChain`
  // is safe to call speculatively on any other turn: `getCurrentChainStep`
  // makes it a harmless no-op once the chain is already fully confirmed.
  const finalTripId = tripId;
  if (result.decisionRevisionRequested) {
    const field = result.decisionRevisionRequested;
    after(() =>
      runStepwiseRevision(supabase, { tripId: finalTripId, field, ...stepwiseChainClients() }).catch((err) => {
        console.error(`runStepwiseRevision failed for trip ${finalTripId}:`, err);
      }),
    );
  } else if (result.workflowState === "requirements_ready") {
    after(() =>
      runStepwiseChain(supabase, { tripId: finalTripId, ...stepwiseChainClients() }).catch((err) => {
        console.error(`runStepwiseChain failed for trip ${finalTripId}:`, err);
      }),
    );
  }

  return { ...result, tripId, sessionId };
}

export interface ReviseTripDecisionInput {
  tripId: string;
  field: RevisableDecisionField;
}

export interface ReviseTripDecisionResult extends RunStepwiseChainResult {
  tripId: string;
}

/**
 * Server Action entry point for the decision-revision loop
 * (`src/workflow/chain-orchestrator.ts`'s `runStepwiseRevision`). No chat UI
 * calls this directly today — `sendMessage`'s auto-chain above calls it once
 * `processIntakeTurn` signals `decisionRevisionRequested` — but it's exposed
 * as its own action too for testing/debugging a revision in isolation.
 */
export async function reviseTripDecision(input: ReviseTripDecisionInput): Promise<ReviseTripDecisionResult> {
  const supabase = createServiceClient();
  await requireOwnedTrip(supabase, input.tripId);
  const result = await runStepwiseRevision(supabase, { tripId: input.tripId, field: input.field, ...stepwiseChainClients() });
  return { ...result, tripId: input.tripId };
}
