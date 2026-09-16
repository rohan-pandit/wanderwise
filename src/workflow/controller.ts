/**
 * Workflow controller (PROJECT_BRIEF.md §8.2). Owns every trip-state
 * transition — callers propose an event; only this module ever decides the
 * resulting state and writes it. It composes three things Phase 2/3 built
 * separately: `validateStateTransition` (the pure decision), the
 * `trip_state_versions` optimistic-concurrency append (the source of
 * truth), and the `trip_events`/`workflow_runs`/`workflow_steps` telemetry
 * (best-effort mirrors of that decision, per §7.3).
 *
 * Retry safety (§7.7/§8.3) applies to `advanceTrip` specifically — every
 * call requires a `correlationId`. If a prior call already appended the
 * state version for that correlation ID, `advanceTrip` doesn't reapply it,
 * but it still re-checks (and, if missing, re-writes) each mirror —
 * `trip_events`, `trips.status`, the `workflow_steps` row, and completing
 * the `workflow_runs` row if the transition was terminal — each guarded by
 * its own correlation-ID lookup. That's what makes it safe to retry a call
 * that threw partway through (network blip, a mirror write failing after
 * the state append already succeeded): resubmitting the same correlation ID
 * resumes exactly the writes that didn't happen yet, rather than either
 * reapplying the transition or silently accepting whatever mirror state
 * happens to exist. `startTrip` has no such protection — see its own
 * docstring.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import { appendTripEvent, findTripEventByCorrelationId } from "@/src/repositories/trip-events";
import {
  appendTripStateVersion,
  findTripStateVersionByCorrelationId,
  getLatestTripState,
  getTripStateAtVersion,
  type TripStateSnapshot,
} from "@/src/repositories/trip-state";
import { createTrip, updateTripStatus, type NewTrip, type Trip } from "@/src/repositories/trips";
import {
  completeWorkflowRun,
  findWorkflowStepByCorrelationId,
  getOrCreateActiveWorkflowRun,
  recordWorkflowStep,
} from "@/src/repositories/workflow-runs";
import {
  isTerminalState,
  validateStateTransition,
  type WorkflowEvent,
  type WorkflowState,
} from "./state-machine";

const SYSTEM_ACTOR = "system";
const GENESIS_OPERATION = "trip_created";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidCorrelationIdError extends Error {
  constructor(correlationId: string) {
    super(
      `"${correlationId}" is not a valid UUID — correlation_id columns (trip_state_versions, trip_events, workflow_steps) are typed uuid.`,
    );
    this.name = "InvalidCorrelationIdError";
  }
}

export class CorrelationIdReusedError extends Error {
  constructor(correlationId: string, requestedEvent: string, originalEvent: string) {
    super(
      `correlationId "${correlationId}" was already used for event "${originalEvent}", not "${requestedEvent}" — reusing a correlation ID across different logical operations isn't supported.`,
    );
    this.name = "CorrelationIdReusedError";
  }
}

export interface AdvanceTripParams {
  tripId: string;
  event: WorkflowEvent;
  actor: string;
  /** Idempotency key — required so retries are safe. See module docstring. */
  correlationId: string;
  proposalHashMatches?: boolean;
  guardrailsPassed?: boolean;
  resumeState?: WorkflowState;
}

export type AdvanceTripResult =
  | { status: "applied"; fromState: WorkflowState; toState: WorkflowState; version: number }
  /** Same correlationId as a previously applied call — mirrors are (re)confirmed written, but the state itself wasn't reapplied. */
  | { status: "replayed"; fromState: WorkflowState; toState: WorkflowState; version: number }
  | { status: "rejected"; reason: string }
  /** Another write claimed the next version first — retry with the same correlationId; the retry either re-validates against the new current state or, if that other write was this same request racing itself, resolves via the idempotency check above. */
  | { status: "conflict" };

interface TransitionMirrors {
  tripId: string;
  fromState: WorkflowState | null;
  toState: WorkflowState;
  event: string;
  actor: string;
  correlationId?: string | null;
}

/**
 * Writes the best-effort mirrors for a transition already durably recorded
 * in `trip_state_versions`. Safe to call more than once for the same
 * correlation ID — each piece is checked for a prior write (by correlation
 * ID) before being written, so a resumed call only fills in what's missing.
 */
async function recordTransitionMirrors(
  supabase: SupabaseClient<Database>,
  mirrors: TransitionMirrors,
): Promise<void> {
  const [existingEvent, run] = await Promise.all([
    mirrors.correlationId
      ? findTripEventByCorrelationId(supabase, mirrors.tripId, mirrors.correlationId)
      : Promise.resolve(null),
    getOrCreateActiveWorkflowRun(supabase, mirrors.tripId),
  ]);

  const writes: Promise<unknown>[] = [updateTripStatus(supabase, mirrors.tripId, mirrors.toState)];
  if (!existingEvent) {
    writes.push(
      appendTripEvent(supabase, {
        tripId: mirrors.tripId,
        eventType: mirrors.event,
        payload: { fromState: mirrors.fromState, toState: mirrors.toState },
        correlationId: mirrors.correlationId,
      }),
    );
  }
  await Promise.all(writes);

  const existingStep = mirrors.correlationId
    ? await findWorkflowStepByCorrelationId(supabase, run.id, mirrors.correlationId)
    : null;
  if (!existingStep) {
    await recordWorkflowStep(supabase, {
      workflowRunId: run.id,
      fromState: mirrors.fromState,
      toState: mirrors.toState,
      event: mirrors.event,
      actor: mirrors.actor,
      correlationId: mirrors.correlationId,
    });
  }

  if (isTerminalState(mirrors.toState)) {
    await completeWorkflowRun(supabase, run.id, mirrors.toState);
  }
}

/**
 * Creates a trip and writes its genesis state version (`created`). Trip
 * creation itself is not idempotency-keyed — a caller that wants
 * duplicate-request protection on creation should dedupe before calling
 * this (out of scope here; see BUILD_LOG.md).
 */
export async function startTrip(
  supabase: SupabaseClient<Database>,
  newTrip: NewTrip,
): Promise<{ trip: Trip; version: number }> {
  const trip = await createTrip(supabase, newTrip);
  const initialState: TripStateSnapshot = { workflowState: "created" };

  const appended = await appendTripStateVersion(supabase, {
    tripId: trip.id,
    expectedVersion: 0,
    state: initialState,
    actor: SYSTEM_ACTOR,
    operationType: GENESIS_OPERATION,
  });
  // expectedVersion 0 on a brand-new trip can't conflict — no row exists yet.
  if (appended.status === "conflict") {
    throw new Error(`Unexpected conflict writing the genesis state for trip ${trip.id}.`);
  }

  await recordTransitionMirrors(supabase, {
    tripId: trip.id,
    fromState: null,
    toState: initialState.workflowState,
    event: GENESIS_OPERATION,
    actor: SYSTEM_ACTOR,
  });

  return { trip, version: appended.version };
}

export async function advanceTrip(
  supabase: SupabaseClient<Database>,
  params: AdvanceTripParams,
): Promise<AdvanceTripResult> {
  if (!UUID_PATTERN.test(params.correlationId)) {
    throw new InvalidCorrelationIdError(params.correlationId);
  }

  const [priorAttempt, current] = await Promise.all([
    findTripStateVersionByCorrelationId(supabase, params.tripId, params.correlationId),
    getLatestTripState(supabase, params.tripId),
  ]);
  if (!current) {
    throw new Error(`Trip ${params.tripId} has no state history — call startTrip first.`);
  }

  let fromState: WorkflowState;
  let toState: WorkflowState;
  let version: number;

  if (priorAttempt) {
    if (priorAttempt.operationType !== params.event) {
      throw new CorrelationIdReusedError(params.correlationId, params.event, priorAttempt.operationType);
    }
    const previous = await getTripStateAtVersion(supabase, params.tripId, priorAttempt.version - 1);
    if (!previous) {
      throw new Error(
        `Trip ${params.tripId} is missing state version ${priorAttempt.version - 1}, needed to resume correlationId ${params.correlationId}.`,
      );
    }
    fromState = previous.state.workflowState;
    toState = priorAttempt.state.workflowState;
    version = priorAttempt.version;
  } else {
    const transition = validateStateTransition({
      tripId: params.tripId,
      fromState: current.state.workflowState,
      event: params.event,
      currentStateVersion: current.version,
      proposalHashMatches: params.proposalHashMatches,
      guardrailsPassed: params.guardrailsPassed,
      resumeState: params.resumeState,
    });
    if (!transition.allowed) {
      return { status: "rejected", reason: transition.reason! };
    }

    const appended = await appendTripStateVersion(supabase, {
      tripId: params.tripId,
      expectedVersion: current.version,
      state: { workflowState: transition.toState! },
      actor: params.actor,
      operationType: params.event,
      correlationId: params.correlationId,
    });
    if (appended.status === "conflict") {
      return { status: "conflict" };
    }

    fromState = current.state.workflowState;
    toState = transition.toState!;
    version = appended.version;
  }

  await recordTransitionMirrors(supabase, {
    tripId: params.tripId,
    fromState,
    toState,
    event: params.event,
    actor: params.actor,
    correlationId: params.correlationId,
  });

  return { status: priorAttempt ? "replayed" : "applied", fromState, toState, version };
}
