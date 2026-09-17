/**
 * `retrieve_activities` (PROJECT_BRIEF.md §12). Embeds the query, delegates
 * similarity + relational filtering (destination, price, accessibility,
 * vibe tags) to Postgres via `matchActivities`, then applies the one filter
 * deliberately left out of the SQL function: `excludeClosedOnDaysConstraint`
 * (`src/domain/constraints.ts`, Phase 2's deterministic constraint engine),
 * reused as-is rather than reimplemented here.
 *
 * Scope boundary, intentional: this only excludes activities closed on
 * specific named weekdays (`excludeClosedOnDays`), not a full date-range
 * feasibility check ("does this activity work across my whole multi-day
 * trip") — that question needs a day-by-day assignment to answer and
 * belongs to `src/domain/feasibility.ts` at itinerary-assembly time, not
 * to candidate retrieval.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import { excludeClosedOnDaysConstraint, filterHardConstraints } from "@/src/domain/constraints";
import {
  matchActivities,
  type MatchedActivity,
} from "@/src/repositories/activities";
import type { EmbeddingClient } from "./embedding-client";
import { RetrievalQueryError } from "./errors";

/**
 * How much to overfetch from Postgres before the closed-days post-filter, so
 * filtering out a few candidates doesn't leave fewer than `topK` results.
 * A heuristic, not a guarantee: `matchActivities`'s SQL `LIMIT` still runs
 * before this filter, so if more than `topK * OVERFETCH_FACTOR` of the
 * closest semantic matches for a destination happen to be closed on the
 * excluded day(s), `retrieveActivities` can legitimately return fewer than
 * `topK` results even though enough open ones exist further down the
 * similarity ranking. Acceptable at this project's seed-data scale
 * (a handful of activities per destination); revisit if a larger catalog
 * makes this a real gap (docs/IMPLEMENTATION_PLAN.md §5).
 */
export const OVERFETCH_FACTOR = 2;

export interface RetrieveActivitiesParams {
  /** Display name only now — the actual filter is `destinationId` (`docs/IMPLEMENTATION_PLAN.md` §5's destination-identifier-space fix). Still used as the embedding query-text fallback below. */
  destination: string;
  destinationId: string;
  /** Free-text description of what's being looked for. If omitted, derived from `vibeTags`, then falls back to `destination`. */
  query?: string;
  vibeTags?: string[];
  excludeClosedOnDays?: string[];
  accessibilityNeeds?: string[];
  minPriceUsd?: number;
  maxPriceUsd?: number;
  topK: number;
  inventoryVersion?: number;
}

export async function retrieveActivities(
  supabase: SupabaseClient<Database>,
  embeddingClient: EmbeddingClient,
  params: RetrieveActivitiesParams,
): Promise<MatchedActivity[]> {
  const queryText = params.query?.trim() || params.vibeTags?.join(", ") || params.destination;
  if (!queryText) {
    throw new RetrievalQueryError("retrieveActivities requires a non-empty `query`, `vibeTags`, or `destination`.");
  }

  const { embeddings } = await embeddingClient.embed([queryText], "query");
  const matches = await matchActivities(supabase, {
    queryEmbedding: embeddings[0],
    matchCount: params.excludeClosedOnDays?.length ? params.topK * OVERFETCH_FACTOR : params.topK,
    destinationId: params.destinationId,
    inventoryVersion: params.inventoryVersion,
    minPriceUsd: params.minPriceUsd,
    maxPriceUsd: params.maxPriceUsd,
    requiredAccessibility: params.accessibilityNeeds,
    vibeTags: params.vibeTags,
  });

  if (!params.excludeClosedOnDays?.length) {
    return matches;
  }

  const { passing } = filterHardConstraints(matches, [
    excludeClosedOnDaysConstraint<MatchedActivity>(params.excludeClosedOnDays),
  ]);
  return passing.slice(0, params.topK);
}
