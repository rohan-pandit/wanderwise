import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import { CURRENT_INVENTORY_VERSION } from "@/src/domain/inventory";
import { hasValues, toVectorLiteral, unwrapOrThrow } from "./shared";

export type Activity = Database["public"]["Tables"]["activities"]["Row"];

export interface ActivitySearchFilter {
  destination: string;
  vibeTags?: string[];
  maxPriceUsd?: number;
  /** Excludes activities closed on this day name, e.g. "monday". */
  excludeClosedOn?: string;
  inventoryVersion?: number;
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
    .eq("destination", filter.destination)
    .eq("inventory_version", filter.inventoryVersion ?? CURRENT_INVENTORY_VERSION);

  if (hasValues(filter.vibeTags)) {
    query = query.overlaps("vibe_tags", filter.vibeTags);
  }
  if (filter.maxPriceUsd !== undefined) {
    query = query.lte("price_usd", filter.maxPriceUsd);
  }

  const data = await unwrapOrThrow(query.order("price_usd", { ascending: true }));

  if (filter.excludeClosedOn) {
    return data.filter(
      (activity) => !activity.closed_days?.includes(filter.excludeClosedOn!),
    );
  }
  return data;
}

/** Shape returned by `match_activities` — same columns as `activities` minus `embedding`, plus `similarity`. */
export type MatchedActivity =
  Database["public"]["Functions"]["match_activities"]["Returns"][number];

export interface ActivitySimilarityFilter {
  queryEmbedding: number[];
  matchCount: number;
  destination: string;
  inventoryVersion?: number;
  minPriceUsd?: number;
  maxPriceUsd?: number;
  requiredAccessibility?: string[];
  vibeTags?: string[];
}

/**
 * Semantic search over `activities.embedding` via the `match_activities`
 * Postgres function (`supabase/migrations/0005_retrieval.sql`). Like
 * `matchDestinations`, this is the raw DB-access half of `retrieve_activities`
 * (PROJECT_BRIEF.md §12) — date/closed-day/opening-hours filtering is
 * deliberately not done here (see the migration's own header comment); the
 * retrieval service applies the existing deterministic constraint engine
 * (`src/domain/constraints.ts`) as a post-filter instead of duplicating that
 * logic in SQL.
 */
export async function matchActivities(
  supabase: SupabaseClient<Database>,
  filter: ActivitySimilarityFilter,
): Promise<MatchedActivity[]> {
  return unwrapOrThrow(
    supabase.rpc("match_activities", {
      query_embedding: toVectorLiteral(filter.queryEmbedding),
      match_count: filter.matchCount,
      filter_destination: filter.destination,
      filter_inventory_version: filter.inventoryVersion ?? CURRENT_INVENTORY_VERSION,
      filter_min_price_usd: filter.minPriceUsd ?? null,
      filter_max_price_usd: filter.maxPriceUsd ?? null,
      filter_required_accessibility: hasValues(filter.requiredAccessibility) ? filter.requiredAccessibility : null,
      filter_vibe_tags: hasValues(filter.vibeTags) ? filter.vibeTags : null,
    }),
  );
}
