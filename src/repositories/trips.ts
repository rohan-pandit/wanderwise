import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import { slugify } from "@/src/domain/trip-slug";
import { unwrapOrThrow } from "./shared";

export type Trip = Database["public"]["Tables"]["trips"]["Row"];

export interface NewTrip {
  sessionId: string;
  userId: string;
  /** Idempotency key for trip creation (`startTrip`, `src/workflow/controller.ts`) — see `getTripByCorrelationId`. */
  correlationId?: string;
  /**
   * User-facing trip name, required by the app's own `createTripAction`
   * (`app/app/actions.ts`) — the only real-user path to `startTrip` — but
   * left optional here so internal/eval callers of `startTrip` that don't
   * go through that screen (`evals/lib/scenario-harness.ts`,
   * `controller.test.ts`) aren't forced to invent one.
   */
  name?: string;
  /** URL-friendly identifier (`generateUniqueTripSlug` below) — like `name`, only ever set by `createTripAction`. */
  slug?: string;
}

export const TRIP_CORRELATION_ID_UNIQUE_VIOLATION = "23505";

export async function createTrip(
  supabase: SupabaseClient<Database>,
  trip: NewTrip,
): Promise<Trip> {
  return unwrapOrThrow(
    supabase
      .from("trips")
      .insert({
        session_id: trip.sessionId,
        user_id: trip.userId,
        correlation_id: trip.correlationId ?? null,
        name: trip.name ?? null,
        slug: trip.slug ?? null,
      })
      .select()
      .single(),
  );
}

/**
 * Turns a trip name into a slug that's actually unique among this user's
 * own trips (`trips_user_id_slug_unique`, `supabase/migrations/0017_trips_slug.sql`
 * — a partial unique index scoped to `(user_id, slug)`, skipping nulls).
 * `slugify` alone can't guarantee this — two trips named "Lisbon Getaway"
 * would otherwise collide — so this checks-then-appends a counter
 * (`lisbon-getaway`, `lisbon-getaway-2`, …) until it finds one that's free.
 * A real concurrent double-create of the exact same name is a low-stakes
 * enough edge case here (unlike `startTrip`'s own correlation-id race) that
 * this doesn't also retry on a unique-violation insert failure — it would
 * just surface as a normal "try again" error, extremely rarely.
 */
export async function generateUniqueTripSlug(
  supabase: SupabaseClient<Database>,
  userId: string,
  name: string,
): Promise<string> {
  const base = slugify(name);
  let candidate = base;
  let attempt = 1;
  while (true) {
    const { data } = await supabase.from("trips").select("id").eq("user_id", userId).eq("slug", candidate).maybeSingle();
    if (!data) return candidate;
    attempt += 1;
    candidate = `${base}-${attempt}`;
  }
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
