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

/** The two event types a chain step's propose/revision failure is ever recorded under — `app/app/actions.ts`'s three cold-start propose actions write `chain_propose_failed`; the chat-driven revision auto-chain (`reviseChainStep`'s `after()` block) writes `chain_revision_failed`. Both share the same `{step, message}` payload shape. */
const CHAIN_STEP_FAILURE_EVENT_TYPES = ["chain_propose_failed", "chain_revision_failed"];

/** The success event type(s) each chain step writes on a propose or confirm (`flight-step.ts`/`hotel-step.ts`/`activities-step.ts`) — anything here found more recent than a failure means the failure is stale, already superseded. */
const CHAIN_STEP_SUCCESS_EVENT_TYPES: Record<string, string[]> = {
  flight: ["flight_step_proposed", "flight_step_confirmed"],
  hotel: ["hotel_step_proposed", "hotel_step_confirmed"],
  activities: ["activities_step_proposed", "activities_step_confirmed"],
};

/**
 * The most recent propose/revision failure for `step`, unless something
 * more recent for that same step (a later successful propose or confirm)
 * already supersedes it — read back into the Intake agent's context
 * (`intake-orchestrator.ts`) so a follow-up chat question like "I don't see
 * any flights, can you check again?" gets an answer grounded in what
 * actually happened last, instead of the model guessing at a cause with no
 * real signal to work from (found live 2026-09-19, debugging a real stuck
 * trip: the model speculated "loosen the budget" when the real, already-
 * known failure reason was an unresolved destination).
 */
export async function getLatestChainStepFailure(
  supabase: SupabaseClient<Database>,
  tripId: string,
  step: string,
): Promise<{ message: string } | null> {
  const relevantTypes = [...CHAIN_STEP_FAILURE_EVENT_TYPES, ...(CHAIN_STEP_SUCCESS_EVENT_TYPES[step] ?? [])];
  const rows = await unwrapOrThrow(
    supabase
      .from("trip_events")
      .select("event_type, payload, created_at")
      .eq("trip_id", tripId)
      .in("event_type", relevantTypes)
      .order("created_at", { ascending: false })
      .limit(1),
  );
  const latest = rows[0];
  if (!latest || !CHAIN_STEP_FAILURE_EVENT_TYPES.includes(latest.event_type)) {
    return null;
  }
  const payload = latest.payload as { step?: string; message?: string } | null;
  if (!payload?.message || payload.step !== step) return null;
  return { message: payload.message };
}
