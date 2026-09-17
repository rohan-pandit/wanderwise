import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/src/config/supabase/database.types";
import { unwrapOrThrow } from "./shared";

export type TripPreferenceRow = Database["public"]["Tables"]["trip_preferences"]["Row"];

export interface NewTripPreference {
  tripId: string;
  field: string;
  value: Json;
  source: string;
  confidence: number;
  status?: string;
}

/** Appends a preference. Callers replacing an existing value for this field should call `retireActiveTripPreferencesForField` first — this function doesn't retract anything itself, so appending a second active row for the same field without retracting the first leaves both active with no way to tell which one is current. */
export async function appendTripPreference(
  supabase: SupabaseClient<Database>,
  preference: NewTripPreference,
): Promise<TripPreferenceRow> {
  return unwrapOrThrow(
    supabase
      .from("trip_preferences")
      .insert({
        trip_id: preference.tripId,
        field: preference.field,
        value: preference.value,
        source: preference.source,
        confidence: preference.confidence,
        status: preference.status ?? "active",
      })
      .select()
      .single(),
  );
}

export async function listActiveTripPreferences(
  supabase: SupabaseClient<Database>,
  tripId: string,
): Promise<TripPreferenceRow[]> {
  return unwrapOrThrow(
    supabase
      .from("trip_preferences")
      .select("*")
      .eq("trip_id", tripId)
      .neq("status", "retracted")
      .order("created_at", { ascending: true }),
  );
}

/** See `retireActiveTripRequirementsForField` — same "at most one active row per field" pattern, for preferences. */
export async function retireActiveTripPreferencesForField(
  supabase: SupabaseClient<Database>,
  tripId: string,
  field: string,
): Promise<void> {
  await unwrapOrThrow(
    supabase
      .from("trip_preferences")
      .update({ status: "retracted" })
      .eq("trip_id", tripId)
      .eq("field", field)
      .neq("status", "retracted")
      .select(),
  );
}
