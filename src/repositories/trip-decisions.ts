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

/** Supersedes every currently-`"proposed"` row for a field, leaving a `"confirmed"` row (if any) untouched. Called by a `propose*Step` before writing a fresh candidate list, so a re-propose doesn't leave the prior list's rows lingering as stale proposals — without disturbing an already-confirmed decision that a mere re-propose shouldn't touch until the user actually picks a replacement. */
export async function retireProposedTripDecisionsForField(
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
      .eq("status", "proposed")
      .select(),
  );
}

/**
 * Supersedes every other non-superseded row for a field — both sibling
 * `"proposed"` candidates AND, critically, any prior `"confirmed"` row for
 * that field. Used at confirm time when promoting a matching proposed row
 * in place (`step-shared.ts`'s `confirmDecisionField`): a first-ever confirm
 * has no prior confirmed row to touch, but *revising* an already-confirmed
 * step (stepwise chain redesign slice 4's per-step "Change" UI) proposes
 * fresh candidates alongside the still-confirmed old one — without also
 * superseding that old confirmed row here, promoting the newly-picked
 * candidate would leave two `"confirmed"` rows for the same field at once,
 * breaking the "at most one confirmed row per field" invariant
 * `getCurrentChainStep` and every step module rely on.
 */
export async function supersedeOtherActiveTripDecisions(
  supabase: SupabaseClient<Database>,
  tripId: string,
  field: string,
  keepDecisionId: string,
): Promise<void> {
  await unwrapOrThrow(
    supabase
      .from("trip_decisions")
      .update({ status: "superseded" })
      .eq("trip_id", tripId)
      .eq("field", field)
      .neq("status", "superseded")
      .neq("id", keepDecisionId)
      .select(),
  );
}

/** Flips every currently-`"proposed"` row for these fields to `"confirmed"` — the other half of the propose/confirm lifecycle a chain step that shows a proposal before confirming it (rather than writing straight to `"confirmed"`, as the flight step originally did) uses. */
export async function confirmTripDecisions(
  supabase: SupabaseClient<Database>,
  tripId: string,
  fields: string[],
): Promise<void> {
  await unwrapOrThrow(
    supabase
      .from("trip_decisions")
      .update({ status: "confirmed" })
      .eq("trip_id", tripId)
      .in("field", fields)
      .eq("status", "proposed")
      .select(),
  );
}
