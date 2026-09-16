import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/src/config/supabase/database.types";
import { unwrapOrThrow } from "./shared";

export type TripEvent = Database["public"]["Tables"]["trip_events"]["Row"];

/** The `trip_created` / `requirements_extracted` / ... vocabulary from PROJECT_BRIEF.md §8.5. */
export interface NewTripEvent {
  tripId: string;
  eventType: string;
  payload: Json;
  /** Must be a UUID — `correlation_id` is typed `uuid` in the schema. */
  correlationId?: string | null;
}

/** Appends to the append-only domain event log (PROJECT_BRIEF.md §8.5) — never updated or deleted. */
export async function appendTripEvent(
  supabase: SupabaseClient<Database>,
  event: NewTripEvent,
): Promise<TripEvent> {
  return unwrapOrThrow(
    supabase
      .from("trip_events")
      .insert({
        trip_id: event.tripId,
        event_type: event.eventType,
        payload: event.payload,
        correlation_id: event.correlationId ?? null,
      })
      .select()
      .single(),
  );
}

/** Looks up a prior write by idempotency key, so a resumed replay doesn't double-write this event. */
export async function findTripEventByCorrelationId(
  supabase: SupabaseClient<Database>,
  tripId: string,
  correlationId: string,
): Promise<TripEvent | null> {
  return unwrapOrThrow(
    supabase
      .from("trip_events")
      .select("*")
      .eq("trip_id", tripId)
      .eq("correlation_id", correlationId)
      .maybeSingle(),
  );
}

export async function listTripEvents(
  supabase: SupabaseClient<Database>,
  tripId: string,
): Promise<TripEvent[]> {
  return unwrapOrThrow(
    supabase
      .from("trip_events")
      .select("*")
      .eq("trip_id", tripId)
      .order("created_at", { ascending: true }),
  );
}
