import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";

export type Destination = Database["public"]["Tables"]["destinations"]["Row"];

export interface DestinationFilter {
  vibeTags?: string[];
  maxDailyCostUsd?: number;
}

/**
 * Structured filter over the destinations table. Not a `retrieve_destinations`
 * tool implementation (that's semantic/embedding-backed, Phase 5) — this is
 * the plain relational query path used until then, and the fallback path for
 * exact vibe-tag/budget filtering once retrieval exists.
 */
export async function findDestinations(
  supabase: SupabaseClient<Database>,
  filter: DestinationFilter = {},
): Promise<Destination[]> {
  let query = supabase.from("destinations").select("*");

  if (filter.vibeTags && filter.vibeTags.length > 0) {
    query = query.overlaps("vibe_tags", filter.vibeTags);
  }
  if (filter.maxDailyCostUsd !== undefined) {
    query = query.lte("estimated_daily_cost_usd", filter.maxDailyCostUsd);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function getDestinationByName(
  supabase: SupabaseClient<Database>,
  name: string,
): Promise<Destination | null> {
  const { data, error } = await supabase
    .from("destinations")
    .select("*")
    .eq("name", name)
    .maybeSingle();
  if (error) throw error;
  return data;
}
