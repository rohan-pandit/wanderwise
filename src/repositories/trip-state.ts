import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/src/config/supabase/database.types";
import { WORKFLOW_STATES, type WorkflowState } from "@/src/workflow/state-machine";
import { unwrapOrThrow } from "./shared";

/**
 * The trip's current-projection payload stored in `trip_state_versions.state`
 * (PROJECT_BRIEF.md §7.3). Only the workflow phase exists as of Phase 3 —
 * structured requirements/preferences/decisions already have their own
 * tables, so this isn't a place to duplicate them; it grows as later phases
 * need more of "what the orchestrator currently sees" cached here for replay.
 */
export interface TripStateSnapshot {
  workflowState: WorkflowState;
}

export interface TripStateVersion {
  version: number;
  state: TripStateSnapshot;
  actor: string;
  operationType: string;
  correlationId: string | null;
  createdAt: string;
}

/** Postgres unique_violation — see `unique (trip_id, version)` on `trip_state_versions`. */
const UNIQUE_VIOLATION = "23505";

export type AppendTripStateResult =
  | { status: "applied"; version: number }
  | { status: "conflict" };

export interface AppendTripStateParams {
  tripId: string;
  /** The version this write was computed against; the new row is written at `expectedVersion + 1`. */
  expectedVersion: number;
  state: TripStateSnapshot;
  actor: string;
  operationType: string;
  /** Must be a UUID — `correlation_id` is typed `uuid` in the schema. */
  correlationId?: string | null;
}

/**
 * Appends the next state version, enforcing optimistic concurrency
 * (PROJECT_BRIEF.md §7.7) via the `unique (trip_id, version)` constraint —
 * if another writer already claimed `expectedVersion + 1`, this insert fails
 * and we report a conflict rather than silently overwriting it.
 */
export async function appendTripStateVersion(
  supabase: SupabaseClient<Database>,
  params: AppendTripStateParams,
): Promise<AppendTripStateResult> {
  const version = params.expectedVersion + 1;
  const { error } = await supabase.from("trip_state_versions").insert({
    trip_id: params.tripId,
    version,
    state: params.state as unknown as Json,
    actor: params.actor,
    operation_type: params.operationType,
    correlation_id: params.correlationId ?? null,
  });

  if (error) {
    if (error.code === UNIQUE_VIOLATION) return { status: "conflict" };
    throw error;
  }
  return { status: "applied", version };
}

export async function getLatestTripState(
  supabase: SupabaseClient<Database>,
  tripId: string,
): Promise<TripStateVersion | null> {
  const row = await unwrapOrThrow(
    supabase
      .from("trip_state_versions")
      .select("*")
      .eq("trip_id", tripId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle(),
  );
  return row ? toTripStateVersion(row) : null;
}

/** Looks up a prior write by idempotency key, so a duplicate request can be answered without reapplying it. */
export async function findTripStateVersionByCorrelationId(
  supabase: SupabaseClient<Database>,
  tripId: string,
  correlationId: string,
): Promise<TripStateVersion | null> {
  const row = await unwrapOrThrow(
    supabase
      .from("trip_state_versions")
      .select("*")
      .eq("trip_id", tripId)
      .eq("correlation_id", correlationId)
      .maybeSingle(),
  );
  return row ? toTripStateVersion(row) : null;
}

/**
 * Reads the state at a specific version — used to recover the `fromState` of
 * an already-applied transition when resuming a replayed `advanceTrip` call
 * (the state at `version - 1` is exactly what that transition moved away
 * from, since versions are sequential and each row is the state *after* its
 * operation).
 */
export async function getTripStateAtVersion(
  supabase: SupabaseClient<Database>,
  tripId: string,
  version: number,
): Promise<TripStateVersion | null> {
  const row = await unwrapOrThrow(
    supabase
      .from("trip_state_versions")
      .select("*")
      .eq("trip_id", tripId)
      .eq("version", version)
      .maybeSingle(),
  );
  return row ? toTripStateVersion(row) : null;
}

export class InvalidTripStateSnapshotError extends Error {
  constructor(tripId: string, version: number, value: unknown) {
    super(
      `trip_state_versions row (trip ${tripId}, version ${version}) has an invalid state payload: ${JSON.stringify(value)}`,
    );
    this.name = "InvalidTripStateSnapshotError";
  }
}

function toTripStateVersion(
  row: Database["public"]["Tables"]["trip_state_versions"]["Row"],
): TripStateVersion {
  const workflowState = (row.state as { workflowState?: unknown } | null)?.workflowState;
  if (
    typeof workflowState !== "string" ||
    !(WORKFLOW_STATES as readonly string[]).includes(workflowState)
  ) {
    throw new InvalidTripStateSnapshotError(row.trip_id, row.version, row.state);
  }
  return {
    version: row.version,
    state: { workflowState: workflowState as WorkflowState },
    actor: row.actor,
    operationType: row.operation_type,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
  };
}
