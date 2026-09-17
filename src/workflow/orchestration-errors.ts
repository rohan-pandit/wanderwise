/**
 * Error types shared by every orchestrator that drives `advanceTrip`
 * (`intake-orchestrator.ts`, `search-orchestrator.ts`) — split out so a
 * caller can catch one of these regardless of which orchestrator produced
 * it, instead of each module defining its own copy.
 */
import type { WorkflowEvent } from "./state-machine";

export class OrchestrationTransitionError extends Error {
  constructor(tripId: string, event: WorkflowEvent, reason: string) {
    super(`Trip ${tripId}: transition "${event}" was rejected: ${reason}`);
    this.name = "OrchestrationTransitionError";
  }
}

/** Distinct from `OrchestrationTransitionError`: a conflict means another writer won a race on the same trip, not that the transition itself is invalid — per `advanceTrip`'s own contract (PROJECT_BRIEF.md §7.7), it's safe (and expected) to retry the whole turn, not a terminal failure. */
export class OrchestrationConflictError extends Error {
  constructor(tripId: string, event: WorkflowEvent) {
    super(`Trip ${tripId}: transition "${event}" conflicted with a concurrent write — safe to retry the whole turn.`);
    this.name = "OrchestrationConflictError";
  }
}
