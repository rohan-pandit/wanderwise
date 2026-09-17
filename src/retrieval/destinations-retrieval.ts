/**
 * `retrieve_destinations` (PROJECT_BRIEF.md §12) — the semantic half of
 * destination search, for the "flexible destination" case where the user
 * hasn't picked one yet. Embeds the query, then delegates the actual
 * similarity + metadata filtering to Postgres via `matchDestinations`
 * (`src/repositories/destinations.ts`) rather than fetching every row and
 * filtering client-side.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import {
  matchDestinations,
  type MatchedDestination,
} from "@/src/repositories/destinations";
import type { EmbeddingClient } from "./embedding-client";
import { RetrievalQueryError } from "./errors";

export interface RetrieveDestinationsParams {
  /** Free-text description of what's being looked for. If omitted, derived from `vibeTags`. */
  query?: string;
  vibeTags?: string[];
  maxDailyCostUsd?: number;
  topK: number;
  inventoryVersion?: number;
}

export async function retrieveDestinations(
  supabase: SupabaseClient<Database>,
  embeddingClient: EmbeddingClient,
  params: RetrieveDestinationsParams,
): Promise<MatchedDestination[]> {
  const queryText = params.query?.trim() || params.vibeTags?.join(", ") || "";
  if (!queryText) {
    throw new RetrievalQueryError("retrieveDestinations requires a non-empty `query` or `vibeTags`.");
  }

  const { embeddings } = await embeddingClient.embed([queryText], "query");
  return matchDestinations(supabase, {
    queryEmbedding: embeddings[0],
    matchCount: params.topK,
    inventoryVersion: params.inventoryVersion,
    maxDailyCostUsd: params.maxDailyCostUsd,
    vibeTags: params.vibeTags,
  });
}
