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

/** Thrown by `getDestinationByName` if more than one destination shares a name (and, when given, country) at the given inventory version — an ambiguous lookup the caller must not silently resolve either way. */
export class AmbiguousDestinationNameError extends Error {
  constructor(name: string, inventoryVersion: number) {
    super(`Multiple destinations named "${name}" exist at inventory version ${inventoryVersion} — ambiguous lookup.`);
    this.name = "AmbiguousDestinationNameError";
  }
}

/** Escapes ILIKE's wildcard characters (`%`, `_`) and its own escape character (`\`) so a search term is matched literally, modulo case — without this, a city name containing one of these (rare, but not impossible) would be misinterpreted as a pattern instead of literal text. Postgres's default LIKE/ILIKE escape character is backslash, so no `ESCAPE` clause is needed alongside this. */
function escapeIlikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Case-insensitive, whitespace-tolerant lookup by display name (and,
 * optionally, country) — the seam that resolves a trip's free-text
 * `destination` requirement to a real `destinations.id` before any inventory
 * search/guardrail check trusts it (closes the identifier-space gap
 * `docs/IMPLEMENTATION_PLAN.md` §5 tracked: `flights`/`hotels`/`activities`
 * matched destination by name alone, with no FK).
 *
 * Found live 2026-09-18: the original version did an exact, case-sensitive
 * `.eq("name", name)` with no `country` filter, so "Madrid, Spain" failed to
 * resolve against a seeded row named exactly "Madrid" even though that
 * destination has real inventory — `resolveTripDestination`
 * (`src/workflow/step-shared.ts`) now splits the free-text requirement into
 * city/country via `parseDestinationQuery` and passes both here. `country`
 * stays optional (not every phrasing states one, and today's seed data has
 * no two destinations sharing a city name at all) — when given, it narrows
 * an otherwise-ambiguous match instead of being required.
 *
 * Uses `.limit(2)` and an explicit branch rather than `.maybeSingle()`,
 * which would otherwise throw an opaque, unhandled PostgREST error the
 * moment two destinations ever shared a name (and country) —
 * `AmbiguousDestinationNameError` makes that failure mode a typed,
 * catchable one instead.
 *
 * Found live 2026-09-19, debugging two real users' stuck trips: an exact
 * match alone still fails a very natural, common shorthand — "New York"
 * doesn't match the seeded "New York City" at all (no substring/fuzzy
 * matching, just case-insensitive-exact). Falls back to a `%contains%`
 * search only when the exact match finds nothing, and only trusts that
 * fallback when it resolves to exactly one destination — 0 or 2+ results
 * still fall through to `UnknownDestinationError`/`AmbiguousDestinationNameError`
 * rather than guessing. This does not handle a true abbreviation with no
 * shared substring ("LA" for "Los Angeles", "NYC" for "New York City") —
 * that would need a hand-maintained alias table, a materially bigger,
 * ongoing-maintenance fix deliberately not built here without deciding
 * that's worth it first.
 */
export async function getDestinationByName(
  supabase: SupabaseClient<Database>,
  name: string,
  inventoryVersion: number = CURRENT_INVENTORY_VERSION,
  country?: string | null,
): Promise<Destination | null> {
  const trimmedName = name.trim();
  const escapedName = escapeIlikeLiteral(trimmedName);
  const trimmedCountry = country?.trim();

  function baseQuery() {
    let query = supabase.from("destinations").select("*").eq("inventory_version", inventoryVersion);
    if (trimmedCountry) {
      query = query.ilike("country", escapeIlikeLiteral(trimmedCountry));
    }
    return query;
  }

  const exactRows = await unwrapOrThrow(baseQuery().ilike("name", escapedName).limit(2));
  if (exactRows.length > 1) {
    throw new AmbiguousDestinationNameError(name, inventoryVersion);
  }
  if (exactRows.length === 1) {
    return exactRows[0];
  }

  const fuzzyRows = await unwrapOrThrow(baseQuery().ilike("name", `%${escapedName}%`).limit(2));
  if (fuzzyRows.length > 1) {
    throw new AmbiguousDestinationNameError(name, inventoryVersion);
  }
  return fuzzyRows[0] ?? null;
}
