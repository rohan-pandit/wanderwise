import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import { unwrapOrThrow } from "./shared";

export type Trip = Database["public"]["Tables"]["trips"]["Row"];

export interface NewTrip {
  sessionId: string;
  userId: string;
  /** Idempotency key for trip creation (`startTrip`, `src/workflow/controller.ts`) — see `getTripByCorrelationId`. */
  correlationId?: string;
}

export const TRIP_CORRELATION_ID_UNIQUE_VIOLATION = "23505";

export async function createTrip(
  supabase: SupabaseClient<Database>,
  trip: NewTrip,
): Promise<Trip> {
  return unwrapOrThrow(
    supabase
      .from("trips")
      .insert({ session_id: trip.sessionId, user_id: trip.userId, correlation_id: trip.correlationId ?? null })
      .select()
      .single(),
  );
}

export async function getTrip(
  supabase: SupabaseClient<Database>,
  tripId: string,
): Promise<Trip | null> {
  return unwrapOrThrow(
    supabase.from("trips").select("*").eq("id", tripId).maybeSingle(),
  );
}

/** Looks up a trip by its creation-time idempotency key (`trips.correlation_id`, `0008_trips_idempotency.sql`'s partial unique index) — the replay/race-recovery half of `startTrip`'s idempotency, mirroring `getOrCreateActiveWorkflowRun`'s check-then-insert-then-refetch-on-conflict pattern. */
export async function getTripByCorrelationId(
  supabase: SupabaseClient<Database>,
  correlationId: string,
): Promise<Trip | null> {
  return unwrapOrThrow(
    supabase.from("trips").select("*").eq("correlation_id", correlationId).maybeSingle(),
  );
}

export class TripNotFoundError extends Error {
  constructor(tripId: string) {
    super(`No trip found with id ${tripId}.`);
    this.name = "TripNotFoundError";
  }
}

/**
 * Updates the denormalized `trips.status` fast-read projection
 * (PROJECT_BRIEF.md §7.3) to match the workflow state that was just written
 * to `trip_state_versions` — that append is the source of truth; this is a
 * best-effort mirror for list/detail queries that shouldn't have to join
 * against the version history just to show a status label.
 *
 * Unlike `completeWorkflowRun`, a zero-row match here is never legitimate
 * (the trip must already exist and be visible to this client) — it's
 * reported as an error rather than silently swallowed, since PostgREST
 * doesn't treat "matched nothing" as an error on its own.
 */
export async function updateTripStatus(
  supabase: SupabaseClient<Database>,
  tripId: string,
  status: string,
): Promise<void> {
  const rows = await unwrapOrThrow(
    supabase.from("trips").update({ status }).eq("id", tripId).select("id"),
  );
  if (rows.length === 0) {
    throw new TripNotFoundError(tripId);
  }
}
