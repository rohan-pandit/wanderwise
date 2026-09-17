/**
 * Shared setup for end-to-end scenario evals (`evals/cases/scenarios.ts`,
 * PROJECT_BRIEF.md §9.6 "end-to-end scenario evaluations" / §19). Unlike the
 * component evals (`evals/cases/intake.ts`, `evals/cases/retrieval.ts`),
 * which call one agent function directly, a scenario drives the real
 * stepwise chain (`src/workflow/*-step.ts` + `intake-orchestrator.ts`)
 * against a real Supabase trip — the same functions `app/app/actions.ts`
 * calls, just without that module's own auth/ownership wrapper
 * (`requireOwnedTrip` needs a cookie-based session from a real request,
 * which a standalone script doesn't have; ownership enforcement itself is
 * exercised by the Server Action layer, not by these domain functions, so
 * calling them directly here is the same layering the app's own unit tests
 * already rely on).
 *
 * `trips`/`sessions` have a hard FK to `auth.users` (ADR-003) — there's no
 * anonymous/unowned state — so every scenario needs a real auth user. Each
 * one is a throwaway (`eval-<uuid>@wanderwise.internal`, admin-created,
 * never signed in), tracked here and deleted by `cleanup()`, which cascades
 * away every session/trip/decision/event it owns. Mirrors the throwaway
 * dev-signin users from the Phase 7 live-verification pass (BUILD_LOG.md,
 * 2026-09-16/17) — created and torn down within one run, nothing standing.
 */
import { randomUUID } from "node:crypto";
import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../src/config/supabase/database.types";
import { createServiceClient } from "../../src/config/supabase/service";
import { AnthropicModelClient } from "../../src/agents/providers/anthropic-model-client";
import { AGENT_MODELS } from "../../src/config/models";
import { VoyageEmbeddingClient } from "../../src/retrieval/providers/voyage-embedding-client";
import { createSession } from "../../src/repositories/sessions";
import { startTrip } from "../../src/workflow/controller";
import type { StepwiseChainClients } from "../../src/workflow/step-router";

export function stepwiseChainClients(): StepwiseChainClients {
  return {
    curatorModelClient: new AnthropicModelClient(AGENT_MODELS.curator),
    writerModelClient: new AnthropicModelClient(AGENT_MODELS.itineraryWriter),
    embeddingClient: new VoyageEmbeddingClient(),
  };
}

export interface ScenarioHarness {
  supabase: SupabaseClient<Database>;
  clients: StepwiseChainClients;
  /** A fresh throwaway auth user, torn down by `cleanup()`. */
  createUser(): Promise<string>;
  /** A fresh session + trip owned by `userId`. */
  newTrip(userId: string): Promise<{ tripId: string; sessionId: string }>;
  /**
   * A real, RLS-scoped client authenticated as `userId` — the anon key, not
   * the service role, so Postgres RLS policies actually apply exactly as
   * they would for that signed-in user in the real app. Every other harness
   * method uses the service-role client (bypasses RLS by design, ownership
   * checked explicitly instead — see `app/app/actions.ts`'s own
   * `requireOwnedTrip`), which can't prove RLS itself denies cross-user
   * access; this is for the one adversarial case that needs to (§19 #16).
   * Generates a real magic-link token via the admin API and verifies it —
   * the same mechanic every prior session's throwaway `/dev-signin` browser
   * routes used (see `BUILD_LOG.md`), just returning a plain client instead
   * of setting browser cookies.
   */
  signInAs(userId: string): Promise<SupabaseClient<Database>>;
  /** Deletes every user this harness created this run — cascades their sessions/trips/everything downstream. Always call, even on failure. */
  cleanup(): Promise<void>;
}

export function createScenarioHarness(): ScenarioHarness {
  const supabase = createServiceClient();
  const createdUserIds: string[] = [];
  const emailByUserId = new Map<string, string>();

  return {
    supabase,
    clients: stepwiseChainClients(),

    async createUser() {
      const email = `eval-${randomUUID()}@wanderwise.internal`;
      const { data, error } = await supabase.auth.admin.createUser({ email, email_confirm: true });
      if (error || !data.user) {
        throw error ?? new Error("admin.createUser returned no user");
      }
      createdUserIds.push(data.user.id);
      emailByUserId.set(data.user.id, email);
      return data.user.id;
    },

    async newTrip(userId: string) {
      const session = await createSession(supabase, userId);
      const { trip } = await startTrip(supabase, { sessionId: session.id, userId });
      return { tripId: trip.id, sessionId: session.id };
    },

    async signInAs(userId: string) {
      const email = emailByUserId.get(userId);
      if (!email) throw new Error(`signInAs: ${userId} wasn't created by this harness's createUser().`);

      const { data, error } = await supabase.auth.admin.generateLink({ type: "magiclink", email });
      if (error || !data.properties?.hashed_token) {
        throw error ?? new Error("generateLink returned no hashed_token");
      }

      const rlsClient = createSupabaseClient<Database>(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      );
      const { error: verifyError } = await rlsClient.auth.verifyOtp({
        type: "email",
        token_hash: data.properties.hashed_token,
      });
      if (verifyError) throw verifyError;

      return rlsClient;
    },

    async cleanup() {
      for (const userId of createdUserIds) {
        const { error } = await supabase.auth.admin.deleteUser(userId);
        if (error) console.error(`failed to delete eval user ${userId}:`, error);
      }
    },
  };
}
