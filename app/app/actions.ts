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
import {
  assembleItinerary,
  reviseItinerary,
  type AssembleItineraryResult,
  type RevisableDecisionField,
} from "@/src/workflow/itinerary-orchestrator";
import { processIntakeTurn, type ProcessIntakeTurnResult } from "@/src/workflow/intake-orchestrator";
import { runSearchAndCuration, type RunSearchAndCurationResult } from "@/src/workflow/search-orchestrator";

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

/**
 * Runs `runSearchAndCuration` then `assembleItinerary` back to back — the
 * actual pipeline body both `assembleTripItinerary` (called directly, e.g.
 * for testing/debugging one step) and `sendMessage`'s auto-chain (below)
 * share, so there's exactly one place that composes them.
 */
async function runAssembleTripItinerary(
  supabase: SupabaseClient<Database>,
  tripId: string,
): Promise<AssembleItineraryResult & { search: RunSearchAndCurationResult }> {
  const curatorModelClient = new AnthropicModelClient(AGENT_MODELS.curator);
  const embeddingClient = new VoyageEmbeddingClient();
  const search = await runSearchAndCuration(supabase, curatorModelClient, embeddingClient, { tripId });
  const writerModelClient = new AnthropicModelClient(AGENT_MODELS.itineraryWriter);
  const result = await assembleItinerary(supabase, writerModelClient, {
    tripId,
    outboundFlights: search.outboundFlights,
    returnFlights: search.returnFlights,
    hotels: search.hotels,
    activities: search.activities,
    curation: search.curation,
  });
  return { ...result, search };
}

/** The revision counterpart to `runAssembleTripItinerary` above — shared by `reviseTripDecision` and `sendMessage`'s auto-chain. */
async function runReviseItinerary(
  supabase: SupabaseClient<Database>,
  tripId: string,
  field: RevisableDecisionField,
): Promise<AssembleItineraryResult> {
  const writerModelClient = new AnthropicModelClient(AGENT_MODELS.itineraryWriter);
  return reviseItinerary(supabase, writerModelClient, { tripId, field });
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
  const finalTripId = tripId;
  if (result.workflowState === "requirements_ready") {
    after(() =>
      runAssembleTripItinerary(supabase, finalTripId).catch((err) => {
        console.error(`assembleTripItinerary failed for trip ${finalTripId}:`, err);
      }),
    );
  } else if (result.decisionRevisionRequested) {
    const field = result.decisionRevisionRequested;
    after(() =>
      runReviseItinerary(supabase, finalTripId, field).catch((err) => {
        console.error(`reviseItinerary failed for trip ${finalTripId}:`, err);
      }),
    );
  }

  return { ...result, tripId, sessionId };
}

export interface BeginSearchInput {
  tripId: string;
}

export interface BeginSearchResult extends RunSearchAndCurationResult {
  tripId: string;
}

/**
 * Server Action entry point for the search/curation orchestrator
 * (`src/workflow/search-orchestrator.ts`, Phase 6 continued). No chat UI
 * triggers this yet (Phase 7) — a real UI would call it once
 * `sendMessage`'s result reports `workflowState: "requirements_ready"` — but
 * it makes the wiring reachable through the real authenticated request path,
 * same rationale as `sendMessage` above.
 */
export async function beginSearch(input: BeginSearchInput): Promise<BeginSearchResult> {
  const supabase = createServiceClient();
  await requireOwnedTrip(supabase, input.tripId);

  const modelClient = new AnthropicModelClient(AGENT_MODELS.curator);
  const embeddingClient = new VoyageEmbeddingClient();
  const result = await runSearchAndCuration(supabase, modelClient, embeddingClient, { tripId: input.tripId });

  return { ...result, tripId: input.tripId };
}

export interface AssembleTripItineraryInput {
  tripId: string;
}

export interface AssembleTripItineraryResult extends AssembleItineraryResult {
  tripId: string;
  search: RunSearchAndCurationResult;
}

/**
 * Server Action entry point spanning both Phase 6 continued slices: runs
 * `runSearchAndCuration` (slice 1) then feeds its result straight into
 * `assembleItinerary` (slice 2) in one round trip. There's no user-facing
 * checkpoint between `assembling_options` and `presenting_draft` — those
 * intermediate workflow states are implementation-level retry/telemetry
 * granularity, not a point a chat UI would ever pause at — so a caller only
 * ever needs the one call once a trip reaches `requirements_ready`.
 * `beginSearch` above stays separately callable for testing/debugging one
 * slice at a time.
 */
export async function assembleTripItinerary(input: AssembleTripItineraryInput): Promise<AssembleTripItineraryResult> {
  const supabase = createServiceClient();
  await requireOwnedTrip(supabase, input.tripId);
  const result = await runAssembleTripItinerary(supabase, input.tripId);
  return { ...result, tripId: input.tripId };
}

export interface ReviseTripDecisionInput {
  tripId: string;
  field: RevisableDecisionField;
}

export interface ReviseTripDecisionResult extends AssembleItineraryResult {
  tripId: string;
}

/**
 * Server Action entry point for the decision-revision loop
 * (`src/workflow/itinerary-orchestrator.ts`'s `reviseItinerary`, Phase 7).
 * No chat UI calls this directly today — `sendMessage`'s auto-chain above
 * calls it once `processIntakeTurn` signals `decisionRevisionRequested` —
 * but it's exposed as its own action too for testing/debugging a revision
 * in isolation, same rationale as `beginSearch`/`assembleTripItinerary`.
 */
export async function reviseTripDecision(input: ReviseTripDecisionInput): Promise<ReviseTripDecisionResult> {
  const supabase = createServiceClient();
  await requireOwnedTrip(supabase, input.tripId);
  const result = await runReviseItinerary(supabase, input.tripId, input.field);
  return { ...result, tripId: input.tripId };
}
