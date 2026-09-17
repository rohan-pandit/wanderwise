import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/src/config/supabase/database.types";
import { unwrapOrThrow } from "./shared";

export type TripRequirementRow = Database["public"]["Tables"]["trip_requirements"]["Row"];

export interface NewTripRequirement {
  tripId: string;
  field: string;
  value: Json;
  source: string;
  confidence: number;
  status?: string;
}

/** Appends a requirement (PROJECT_BRIEF.md §7.1). Callers that are replacing an existing value for this field should call `retireActiveTripRequirementsForField` first — this function itself doesn't retract anything, so appending a second active row for the same field without retracting the first leaves both active with no way to tell which one is current. */
export async function appendTripRequirement(
  supabase: SupabaseClient<Database>,
  requirement: NewTripRequirement,
): Promise<TripRequirementRow> {
  return unwrapOrThrow(
    supabase
      .from("trip_requirements")
      .insert({
        trip_id: requirement.tripId,
        field: requirement.field,
        value: requirement.value,
        source: requirement.source,
        confidence: requirement.confidence,
        status: requirement.status ?? "active",
      })
      .select()
      .single(),
  );
}

/** All non-retracted requirements for a trip — what `checkRequirementsComplete` and the Intake agent's "current trip state" slice both read. */
export async function listActiveTripRequirements(
  supabase: SupabaseClient<Database>,
  tripId: string,
): Promise<TripRequirementRow[]> {
  return unwrapOrThrow(
    supabase
      .from("trip_requirements")
      .select("*")
      .eq("trip_id", tripId)
      .neq("status", "retracted")
      .order("created_at", { ascending: true }),
  );
}

/**
 * Marks every currently-active row for this field as retracted — call
 * before appending a new value for a field that may already have one, so at
 * most one requirement row per field is ever active at a time. A no-op
 * (matches zero rows) the first time a field is set. PROJECT_BRIEF.md §7.1
 * models a revision as superseding the prior value, not living alongside it.
 */
export async function retireActiveTripRequirementsForField(
  supabase: SupabaseClient<Database>,
  tripId: string,
  field: string,
): Promise<void> {
  await unwrapOrThrow(
    supabase
      .from("trip_requirements")
      .update({ status: "retracted" })
      .eq("trip_id", tripId)
      .eq("field", field)
      .neq("status", "retracted")
      .select(),
  );
}
