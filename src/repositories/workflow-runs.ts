import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import type { WorkflowState } from "@/src/workflow/state-machine";
import { unwrapOrThrow } from "./shared";

export type WorkflowRun = Database["public"]["Tables"]["workflow_runs"]["Row"];
export type WorkflowStep = Database["public"]["Tables"]["workflow_steps"]["Row"];

const ACTIVE_STATUS = "running";

/**
 * Workflow execution telemetry (PROJECT_BRIEF.md §8.5) — one run spans every
 * step from a trip entering planning to it reaching a terminal state. A trip
 * has at most one active (not-yet-completed) run at a time; a new one starts
 * only once the previous run has completed.
 *
 * Known gap: this is a plain select-then-insert with no DB constraint behind
 * it (unlike `trip_state_versions`'s `unique(trip_id, version)`), so two
 * concurrent calls for the same trip that both see no active run could both
 * insert one. Not closed yet — would need a partial unique index on
 * `workflow_runs(trip_id) where status = 'running'`, deferred until a real
 * concurrent caller exists (nothing calls this concurrently as of Phase 3;
 * the workflow controller is the only caller, and it's not yet invoked from
 * more than one place at a time).
 */
export async function getOrCreateActiveWorkflowRun(
  supabase: SupabaseClient<Database>,
  tripId: string,
): Promise<WorkflowRun> {
  const existing = await unwrapOrThrow(
    supabase
      .from("workflow_runs")
      .select("*")
      .eq("trip_id", tripId)
      .eq("status", ACTIVE_STATUS)
      .is("completed_at", null)
      .maybeSingle(),
  );
  if (existing) return existing;

  return unwrapOrThrow(
    supabase
      .from("workflow_runs")
      .insert({ trip_id: tripId, status: ACTIVE_STATUS })
      .select()
      .single(),
  );
}

/**
 * Idempotent: only updates a run that isn't already completed, so calling
 * this twice for the same run (e.g. a resumed replay) is a harmless no-op
 * the second time rather than overwriting `completed_at`.
 */
export async function completeWorkflowRun(
  supabase: SupabaseClient<Database>,
  workflowRunId: string,
  status: string,
): Promise<void> {
  await unwrapOrThrow(
    supabase
      .from("workflow_runs")
      .update({ status, completed_at: new Date().toISOString() })
      .eq("id", workflowRunId)
      .is("completed_at", null)
      .select(),
  );
}

export interface NewWorkflowStep {
  workflowRunId: string;
  fromState: WorkflowState | null;
  toState: WorkflowState | null;
  event: string;
  actor: string;
  /** Must be a UUID — `correlation_id` is typed `uuid` in the schema. */
  correlationId?: string | null;
}

export async function recordWorkflowStep(
  supabase: SupabaseClient<Database>,
  step: NewWorkflowStep,
): Promise<WorkflowStep> {
  return unwrapOrThrow(
    supabase
      .from("workflow_steps")
      .insert({
        workflow_run_id: step.workflowRunId,
        from_state: step.fromState,
        to_state: step.toState,
        event: step.event,
        actor: step.actor,
        correlation_id: step.correlationId ?? null,
      })
      .select()
      .single(),
  );
}

/** Looks up a prior write by idempotency key, so a resumed replay doesn't double-write this step. */
export async function findWorkflowStepByCorrelationId(
  supabase: SupabaseClient<Database>,
  workflowRunId: string,
  correlationId: string,
): Promise<WorkflowStep | null> {
  return unwrapOrThrow(
    supabase
      .from("workflow_steps")
      .select("*")
      .eq("workflow_run_id", workflowRunId)
      .eq("correlation_id", correlationId)
      .maybeSingle(),
  );
}
