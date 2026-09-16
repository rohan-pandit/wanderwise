import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client. Bypasses RLS entirely — this is how
 * internal/telemetry tables (agent_runs, tool_calls, guardrail_events,
 * workflow_runs, workflow_steps, eval_runs, eval_results) get written,
 * since those have RLS enabled with no policies for anon/authenticated
 * (see supabase/migrations/0001_initial_schema.sql).
 *
 * The `server-only` import makes bundling this into client code a build
 * error. Never pass this client's result to a Client Component, and never
 * use it for anything a user-scoped RLS check should be gating.
 */
export function createServiceClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
