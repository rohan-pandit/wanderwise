import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import { CURRENT_INVENTORY_VERSION } from "@/src/domain/inventory";
import { hasValues, toVectorLiteral, unwrapOrThrow } from "./shared";

export type Destination = Database["public"]["Tables"]["destinations"]["Row"];

export interface DestinationFilter {
  vibeTags?: string[];
  maxDailyCostUsd?: number;
  inventoryVersion?: number;
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
  let query = supabase
    .from("destinations")
    .select("*")
    .eq("inventory_version", filter.inventoryVersion ?? CURRENT_INVENTORY_VERSION);

  if (hasValues(filter.vibeTags)) {
    query = query.overlaps("vibe_tags", filter.vibeTags);
  }
  if (filter.maxDailyCostUsd !== undefined) {
    query = query.lte("estimated_daily_cost_usd", filter.maxDailyCostUsd);
  }

  return unwrapOrThrow(query);
}

/** Shape returned by `match_destinations` — a projection of `destinations`, not the full row (no `source`/`embedding`), plus `similarity`. */
export type MatchedDestination =
  Database["public"]["Functions"]["match_destinations"]["Returns"][number];

export interface DestinationSimilarityFilter {
  queryEmbedding: number[];
  matchCount: number;
  inventoryVersion?: number;
  maxDailyCostUsd?: number;
  vibeTags?: string[];
}

/**
 * Semantic search over `destinations.embedding` via the `match_destinations`
 * Postgres function (`supabase/migrations/0005_retrieval.sql`) — cosine
 * similarity with metadata pre-filtering done inside Postgres, not fetched
 * and filtered client-side. This is the raw DB-access half of the
 * `retrieve_destinations` tool (PROJECT_BRIEF.md §12); embedding the query
 * text itself is the retrieval service's job (`src/retrieval/`), not this
 * repository's.
 */
export async function matchDestinations(
  supabase: SupabaseClient<Database>,
  filter: DestinationSimilarityFilter,
): Promise<MatchedDestination[]> {
  return unwrapOrThrow(
    supabase.rpc("match_destinations", {
      query_embedding: toVectorLiteral(filter.queryEmbedding),
      match_count: filter.matchCount,
      filter_inventory_version: filter.inventoryVersion ?? CURRENT_INVENTORY_VERSION,
      filter_max_daily_cost_usd: filter.maxDailyCostUsd ?? null,
      filter_vibe_tags: hasValues(filter.vibeTags) ? filter.vibeTags : null,
    }),
  );
}

export async function getDestinationByName(
  supabase: SupabaseClient<Database>,
  name: string,
  inventoryVersion: number = CURRENT_INVENTORY_VERSION,
): Promise<Destination | null> {
  return unwrapOrThrow(
    supabase
      .from("destinations")
      .select("*")
      .eq("name", name)
      .eq("inventory_version", inventoryVersion)
      .maybeSingle(),
  );
}
