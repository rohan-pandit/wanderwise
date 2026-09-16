import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";

export type Activity = Database["public"]["Tables"]["activities"]["Row"];

export interface ActivitySearchFilter {
  destination: string;
  vibeTags?: string[];
  maxPriceUsd?: number;
  /** Excludes activities closed on this day name, e.g. "Monday". */
  excludeClosedOn?: string;
}

/**
 * Relational query layer for activities. This is the exact-match fallback —
 * `retrieve_activities` (PROJECT_BRIEF.md §12.1) is the semantic/embedding
 * search over this same table, added in Phase 5.
 */
export async function findActivities(
  supabase: SupabaseClient<Database>,
  filter: ActivitySearchFilter,
): Promise<Activity[]> {
  let query = supabase
    .from("activities")
    .select("*")
    .eq("destination", filter.destination);

  if (filter.vibeTags && filter.vibeTags.length > 0) {
    query = query.overlaps("vibe_tags", filter.vibeTags);
  }
  if (filter.maxPriceUsd !== undefined) {
    query = query.lte("price_usd", filter.maxPriceUsd);
  }

  const { data, error } = await query.order("price_usd", { ascending: true });
  if (error) throw error;

  if (filter.excludeClosedOn) {
    return data.filter(
      (activity) => !activity.closed_days?.includes(filter.excludeClosedOn!),
    );
  }
  return data;
}
