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
import { createClient } from "@/src/config/supabase/server";
import { createServiceClient } from "@/src/config/supabase/service";
import { AnthropicModelClient } from "@/src/agents/providers/anthropic-model-client";
import { AGENT_MODELS } from "@/src/config/models";
import { VoyageEmbeddingClient } from "@/src/retrieval/providers/voyage-embedding-client";
import { createSession } from "@/src/repositories/sessions";
import { getTrip } from "@/src/repositories/trips";
import { startTrip } from "@/src/workflow/controller";
import { processIntakeTurn, type ProcessIntakeTurnResult } from "@/src/workflow/intake-orchestrator";
import { runSearchAndCuration, type RunSearchAndCurationResult } from "@/src/workflow/search-orchestrator";

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
  const authClient = await createClient();
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser();
  if (authError || !user) {
    throw new Error("Not authenticated.");
  }

  const supabase = createServiceClient();
  const trip = await getTrip(supabase, input.tripId);
  if (!trip || trip.user_id !== user.id) {
    throw new Error(`Trip ${input.tripId} not found.`);
  }

  const modelClient = new AnthropicModelClient(AGENT_MODELS.curator);
  const embeddingClient = new VoyageEmbeddingClient();
  const result = await runSearchAndCuration(supabase, modelClient, embeddingClient, { tripId: input.tripId });

  return { ...result, tripId: input.tripId };
}
