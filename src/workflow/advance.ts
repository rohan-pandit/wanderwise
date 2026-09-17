/**
 * `advanceTrip` + its Layer 4 (workflow authorization) guardrail log +
 * conflict/rejection branching, in one place — every orchestrator that
 * drives a transition needs exactly this sequence (call, log either way,
 * throw a typed error on anything but success), and duplicating it per call
 * site (`intake-orchestrator.ts` originally had two copies) is a drift risk
 * as more orchestrators are added.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import { recordGuardrailEvent } from "@/src/repositories/guardrail-events";
import { advanceTrip, type AdvanceTripParams } from "./controller";
import { OrchestrationConflictError, OrchestrationTransitionError } from "./orchestration-errors";
import type { WorkflowState } from "./state-machine";

export interface AdvanceOrThrowParams extends AdvanceTripParams {
  /** Attributed as the guardrail event's `agent_name`. */
  agentName: string;
  workflowRunId?: string | null;
}

/** Returns the resulting state on success (`applied`/`replayed`); throws `OrchestrationConflictError`/`OrchestrationTransitionError` otherwise. */
export async function advanceOrThrow(
  supabase: SupabaseClient<Database>,
  params: AdvanceOrThrowParams,
): Promise<WorkflowState> {
  const { agentName, workflowRunId, ...advanceParams } = params;
  const advanced = await advanceTrip(supabase, advanceParams);
  await recordGuardrailEvent(supabase, {
    tripId: params.tripId,
    agentName,
    guardrailName: "workflow_transition_authorization",
    layer: "workflow_authorization",
    triggered: advanced.status !== "applied" && advanced.status !== "replayed",
    detail: advanced.status === "rejected" ? advanced.reason : advanced.status === "conflict" ? "conflict" : null,
    workflowRunId,
  });
  if (advanced.status === "conflict") {
    throw new OrchestrationConflictError(params.tripId, params.event);
  }
  if (advanced.status !== "applied" && advanced.status !== "replayed") {
    throw new OrchestrationTransitionError(params.tripId, params.event, advanced.reason ?? "was rejected");
  }
  return advanced.toState;
}
