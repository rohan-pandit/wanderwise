import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import { unwrapOrThrow } from "./shared";

export type GuardrailEvent = Database["public"]["Tables"]["guardrail_events"]["Row"];
export type GuardrailLayer = GuardrailEvent["layer"];

/** One row per guardrail check (PROJECT_BRIEF.md §9.1's four layers), logged whether or not it triggered — "which guardrail fires most" (§13.3) needs the full population, not just the triggers. */
export interface NewGuardrailEvent {
  sessionId?: string | null;
  tripId?: string | null;
  agentName?: string | null;
  guardrailName: string;
  layer: GuardrailLayer;
  triggered: boolean;
  detail?: string | null;
  workflowRunId?: string | null;
}

export async function recordGuardrailEvent(
  supabase: SupabaseClient<Database>,
  event: NewGuardrailEvent,
): Promise<GuardrailEvent> {
  return unwrapOrThrow(
    supabase
      .from("guardrail_events")
      .insert({
        session_id: event.sessionId ?? null,
        trip_id: event.tripId ?? null,
        agent_name: event.agentName ?? null,
        guardrail_name: event.guardrailName,
        layer: event.layer,
        triggered: event.triggered,
        detail: event.detail ?? null,
        workflow_run_id: event.workflowRunId ?? null,
      })
      .select()
      .single(),
  );
}
