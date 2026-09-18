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
import { categoryConstraint, excludeClosedOnDaysConstraint, filterHardConstraints, type HardConstraint } from "@/src/domain/constraints";
import {
  matchActivities,
  type MatchedActivity,
} from "@/src/repositories/activities";
import type { EmbeddingClient } from "./embedding-client";
import { RetrievalQueryError } from "./errors";

/**
 * Starting overfetch multiplier for the initial `matchActivities` call, before
 * the closed-days post-filter (`match_activities`'s SQL `LIMIT` runs before
 * that filter, which is applied here in application code). If the first
 * fetch doesn't yield `topK` passing results, `retrieveActivities` widens the
 * query and retries (see `MAX_MATCH_COUNT` below) rather than accepting a
 * short result the ranking could have filled further down
 * (docs/IMPLEMENTATION_PLAN.md §5).
 */
export const OVERFETCH_FACTOR = 2;

/**
 * Upper bound on how far a single `retrieveActivities` call will widen its
 * `matchActivities` query while retrying to fill `topK` (see the loop below).
 * Doubling converges in very few iterations even at a much larger catalog
 * size than this project's seed data — this cap exists purely as a
 * defensive ceiling on worst-case query cost, not because the doubling
 * strategy itself needs one to terminate (it already terminates naturally
 * the moment Postgres returns fewer rows than asked for, meaning every
 * matching activity for the destination has been seen).
 */
export const MAX_MATCH_COUNT = 200;

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
  /** Restricts results to these `activities.category` values (e.g. "food", "spa") — a user-chosen activity-preference filter, applied the same post-filter way as `excludeClosedOnDays` (see `categoryConstraint`, `src/domain/constraints.ts`). */
  categories?: string[];
  topK: number;
  inventoryVersion?: number;
}

export async function retrieveActivities(
  supabase: SupabaseClient<Database>,
  embeddingClient: EmbeddingClient,
  params: RetrieveActivitiesParams,
): Promise<MatchedActivity[]> {
  const queryText = params.query?.trim() || params.vibeTags?.join(", ") || params.categories?.join(", ") || params.destination;
  if (!queryText) {
    throw new RetrievalQueryError("retrieveActivities requires a non-empty `query`, `vibeTags`, or `destination`.");
  }

  const { embeddings } = await embeddingClient.embed([queryText], "query");
  const queryEmbedding = embeddings[0];

  const fetchMatches = (matchCount: number) =>
    matchActivities(supabase, {
      queryEmbedding,
      matchCount,
      destinationId: params.destinationId,
      inventoryVersion: params.inventoryVersion,
      minPriceUsd: params.minPriceUsd,
      maxPriceUsd: params.maxPriceUsd,
      requiredAccessibility: params.accessibilityNeeds,
      vibeTags: params.vibeTags,
    });

  const postFilterConstraints: HardConstraint<MatchedActivity>[] = [];
  if (params.excludeClosedOnDays?.length) {
    postFilterConstraints.push(excludeClosedOnDaysConstraint<MatchedActivity>(params.excludeClosedOnDays));
  }
  if (params.categories?.length) {
    postFilterConstraints.push(categoryConstraint<MatchedActivity>(params.categories));
  }

  if (postFilterConstraints.length === 0) {
    return fetchMatches(params.topK);
  }

  let matchCount = Math.min(params.topK * OVERFETCH_FACTOR, MAX_MATCH_COUNT);
  let matches = await fetchMatches(matchCount);
  let passing = filterHardConstraints(matches, postFilterConstraints).passing;

  // Widen and retry while the post-filter has under-filled `topK` and
  // there's reason to believe a bigger fetch would surface more: Postgres
  // returning exactly as many rows as asked for means there could be more
  // beyond the current LIMIT; returning fewer means every matching activity
  // for this destination has already been seen, so retrying would just
  // repeat the same query for no gain.
  while (passing.length < params.topK && matches.length === matchCount && matchCount < MAX_MATCH_COUNT) {
    matchCount = Math.min(matchCount * OVERFETCH_FACTOR, MAX_MATCH_COUNT);
    matches = await fetchMatches(matchCount);
    passing = filterHardConstraints(matches, postFilterConstraints).passing;
  }

  return passing.slice(0, params.topK);
}
