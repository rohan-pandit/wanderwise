import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/src/config/supabase/database.types";

/**
 * App-level activity that no domain table records: sign-ins, failed
 * sign-ins, magic-link requests, and server-action failures
 * (`supabase/migrations/0021_app_events.sql` documents each type).
 * Service-role only, read by `/internal/users`.
 */
export type AppEventType =
  | "sign_in_link_requested"
  | "sign_in_link_failed"
  | "sign_in_succeeded"
  | "auth_callback_failed"
  | "action_failed";

export interface NewAppEvent {
  eventType: AppEventType;
  userId?: string | null;
  email?: string | null;
  tripId?: string | null;
  payload?: Json;
}

/** Enough to read an error message on a dashboard; stops a pathological error string from bloating a telemetry row. */
export const MAX_EVENT_MESSAGE_LENGTH = 500;

export function truncateMessage(message: string): string {
  return message.length > MAX_EVENT_MESSAGE_LENGTH ? `${message.slice(0, MAX_EVENT_MESSAGE_LENGTH)}…` : message;
}

/**
 * Lower-cased and trimmed, the way Supabase Auth stores emails, so a
 * link request can be matched to its account later. Returns `null` for
 * anything that isn't plausibly an email. The sign-in logging action is
 * public (the user isn't signed in yet), so this also stops it being used
 * to write arbitrary text.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/** Postgres foreign_key_violation. */
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Best-effort: telemetry must never break the flow it's observing, so a
 * failed write is logged to the server console and swallowed.
 *
 * A failure on a trip id that doesn't exist (a stale tab, a mistyped link)
 * is exactly the kind worth seeing, but `trip_id` is a foreign key, so that
 * insert is rejected. It's retried once with the id moved into
 * `payload.unknownTripId` instead of being lost. The same applies to a
 * `user_id` whose account is gone.
 */
export async function recordAppEvent(supabase: SupabaseClient<Database>, event: NewAppEvent): Promise<void> {
  const row = {
    event_type: event.eventType,
    user_id: event.userId ?? null,
    email: event.email ?? null,
    trip_id: event.tripId ?? null,
    payload: event.payload ?? {},
  };
  // Full row first; then without the trip; then without the user too.
  const attempts = [
    row,
    { ...row, trip_id: null, payload: { ...asObject(row.payload), unknownTripId: row.trip_id } },
    { ...row, trip_id: null, user_id: null, payload: { ...asObject(row.payload), unknownTripId: row.trip_id, unknownUserId: row.user_id } },
  ];
  try {
    let error = null;
    for (const attempt of attempts) {
      ({ error } = await supabase.from("app_events").insert(attempt));
      if (error?.code !== FOREIGN_KEY_VIOLATION) break;
    }
    if (error) console.error(`failed to record app event ${event.eventType}:`, error);
  } catch (err) {
    console.error(`failed to record app event ${event.eventType}:`, err);
  }
}

function asObject(payload: Json): { [key: string]: Json | undefined } {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : { value: payload };
}
