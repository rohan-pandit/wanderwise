import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/src/config/supabase/database.types";
import { unwrapOrThrow } from "./shared";

export type TripDecisionRow = Database["public"]["Tables"]["trip_decisions"]["Row"];

export interface NewTripDecision {
  tripId: string;
  field: string;
  value: Json;
  source: string;
  /** Defaults to "proposed" (PROJECT_BRIEF.md §7.6's approval lifecycle: 'proposed' | 'confirmed' | 'superseded' — distinct from `trip_requirements`/`trip_preferences`'s 'active'/'confirmed'/'retracted', since a decision tracks approval, not just presence). */
  status?: string;
}

/** Appends a decision. Callers replacing an existing value for this field should call `retireActiveTripDecisionsForField` first — this function doesn't retract anything itself, so appending a second non-superseded row for the same field without retiring the first leaves both live with no way to tell which one is current. */
export async function appendTripDecision(
  supabase: SupabaseClient<Database>,
  decision: NewTripDecision,
): Promise<TripDecisionRow> {
  return unwrapOrThrow(
    supabase
      .from("trip_decisions")
      .insert({
        trip_id: decision.tripId,
        field: decision.field,
        value: decision.value,
        source: decision.source,
        status: decision.status ?? "proposed",
      })
      .select()
      .single(),
  );
}

/** Every non-superseded decision for a trip — 'proposed' and 'confirmed' both count as current, matching how `trip_requirements`' 'active'/'confirmed' both count as present. */
export async function listActiveTripDecisions(
  supabase: SupabaseClient<Database>,
  tripId: string,
): Promise<TripDecisionRow[]> {
  return unwrapOrThrow(
    supabase
      .from("trip_decisions")
      .select("*")
      .eq("trip_id", tripId)
      .neq("status", "superseded")
      .order("created_at", { ascending: true }),
  );
}

/** Marks every currently-non-superseded row for this field as superseded — call before appending a new value for a field that may already have one, so at most one decision row per field is ever current at a time. A no-op the first time a field is set. */
export async function retireActiveTripDecisionsForField(
  supabase: SupabaseClient<Database>,
  tripId: string,
  field: string,
): Promise<void> {
  await unwrapOrThrow(
    supabase
      .from("trip_decisions")
      .update({ status: "superseded" })
      .eq("trip_id", tripId)
      .eq("field", field)
      .neq("status", "superseded")
      .select(),
  );
}
