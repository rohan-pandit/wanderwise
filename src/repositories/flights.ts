import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import { CURRENT_INVENTORY_VERSION } from "@/src/domain/inventory";
import { localDateInTimeZone } from "@/src/domain/dates";
import { generateFlightsForDate } from "@/src/domain/flight-generator";
import { haulMultiplier } from "@/src/domain/geography";
import type { FlightSearchProvider } from "./flight-provider";
import { unwrapOrThrow } from "./shared";

export type Flight = Database["public"]["Tables"]["flights"]["Row"];

export interface FlightSearchFilter {
  /**
   * A flight leg's two endpoints aren't both always a seeded `destinations`
   * row — a traveler's home city ("New York") never is. Callers supply
   * whichever of `origin`/`originId` (and `destination`/`destinationId`)
   * actually applies to a given search: the seeded-destination side by id
   * (closes the identifier-space gap `docs/IMPLEMENTATION_PLAN.md` §5
   * tracked), the free-text home-city side by name.
   */
  origin?: string;
  originId?: string;
  destination?: string;
  destinationId?: string;
  /** ISO date (YYYY-MM-DD) — matches departures on this calendar day, in the flight's own local timezone. */
  departureDate?: string;
  maxPriceUsd?: number;
  excludeRedEye?: boolean;
  inventoryVersion?: number;
  /**
   * The real seeded destination side's country, if known — used only by the
   * synthetic flight generator's haul-distance pricing (`src/domain/
   * flight-generator.ts`) when a real search finds zero rows. Never used to
   * filter the real-rows query. Whichever of these is set (a route only ever
   * has one seeded-destination side in this app's model) wins; if neither is
   * set, generation falls back to a default haul multiplier.
   */
  originCountry?: string | null;
  destinationCountry?: string | null;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function safeHaulMultiplier(country: string | null | undefined): number {
  if (!country) return 1.3;
  try {
    return haulMultiplier(country);
  } catch {
    return 1.3;
  }
}

async function queryRealFlights(
  supabase: SupabaseClient<Database>,
  filter: FlightSearchFilter,
): Promise<Flight[]> {
  let query = supabase
    .from("flights")
    .select("*")
    .eq("inventory_version", filter.inventoryVersion ?? CURRENT_INVENTORY_VERSION);

  if (filter.origin !== undefined) query = query.eq("origin", filter.origin);
  if (filter.originId !== undefined) query = query.eq("origin_id", filter.originId);
  if (filter.destination !== undefined) query = query.eq("destination", filter.destination);
  if (filter.destinationId !== undefined) query = query.eq("destination_id", filter.destinationId);

  if (filter.departureDate) {
    // departure_time is a timestamptz, stored and returned normalized to
    // UTC — it does not preserve the flight's local offset, so a UTC
    // day-boundary query can miss (or wrongly include) flights near
    // midnight depending on departure_time_zone. Widen the DB-level query
    // by a day on each side (safely covers any real-world UTC offset,
    // -12..+14) and filter to the exact local calendar date below, in
    // application code, using departure_time_zone.
    const requested = new Date(`${filter.departureDate}T00:00:00Z`).getTime();
    query = query
      .gte("departure_time", new Date(requested - ONE_DAY_MS).toISOString())
      .lt("departure_time", new Date(requested + 2 * ONE_DAY_MS).toISOString());
  }
  if (filter.maxPriceUsd !== undefined) {
    query = query.lte("price_usd", filter.maxPriceUsd);
  }
  if (filter.excludeRedEye) {
    query = query.eq("is_red_eye", false);
  }

  const data = await unwrapOrThrow(query.order("price_usd", { ascending: true }));

  if (filter.departureDate) {
    return data.filter(
      (flight) =>
        localDateInTimeZone(
          flight.departure_time,
          flight.departure_time_zone ?? "UTC",
        ) === filter.departureDate,
    );
  }
  return data;
}

function matchesRequestedFilter(flight: Flight, filter: { maxPriceUsd?: number; excludeRedEye?: boolean }): boolean {
  if (filter.maxPriceUsd !== undefined && flight.price_usd > filter.maxPriceUsd) return false;
  if (filter.excludeRedEye && flight.is_red_eye) return false;
  return true;
}

/**
 * Relational query layer backing the `search_flights` model-facing tool
 * (PROJECT_BRIEF.md §12.1). This function only does deterministic filtering —
 * hard-constraint enforcement, budget checks, and ranking are separate
 * deterministic services (Phase 2), not folded in here.
 *
 * Falls back to the deterministic synthetic flight generator
 * (`src/domain/flight-generator.ts`) when a real search for a specific
 * route+date finds nothing — pre-seeding literal rows for every future date
 * across ~640 destinations is combinatorially infeasible, so gaps are
 * filled on demand instead and persisted (`source: "generated"`) so the same
 * route+date always returns the same flights afterward. Only fires when
 * `departureDate` plus both `origin` and `destination` (the text names,
 * needed to build a valid row) are all present — otherwise this behaves
 * exactly as before. A route that genuinely doesn't operate on the
 * requested weekday still correctly returns `[]` — a realistic "no flight
 * that day," not an error.
 */
export async function findFlights(
  supabase: SupabaseClient<Database>,
  filter: FlightSearchFilter,
): Promise<Flight[]> {
  const rows = await queryRealFlights(supabase, filter);
  if (rows.length > 0) return rows;
  if (!filter.departureDate || !filter.origin || !filter.destination) return rows;

  const multiplier = safeHaulMultiplier(filter.destinationCountry ?? filter.originCountry);
  const generated = generateFlightsForDate(filter.origin, filter.destination, filter.departureDate, multiplier);
  if (generated.length === 0) return [];

  const inventoryVersion = filter.inventoryVersion ?? CURRENT_INVENTORY_VERSION;
  const rowsToInsert: Database["public"]["Tables"]["flights"]["Insert"][] = generated.map((option) => ({
    origin: filter.origin!,
    origin_id: filter.originId ?? null,
    destination: filter.destination!,
    destination_id: filter.destinationId ?? null,
    inventory_version: inventoryVersion,
    source: "generated",
    ...option,
  }));

  const inserted = await unwrapOrThrow(
    supabase.from("flights").insert(rowsToInsert).select("*").order("price_usd", { ascending: true }),
  );
  return inserted.filter((flight) => matchesRequestedFilter(flight, filter));
}

/**
 * A recently-cached `source = provider.name` row is reused rather than
 * calling out again — `findFlightsFromProvider` below is rate-limited and
 * metered (SerpAPI's free tier: 250 searches/month, 50/hour), so treating
 * every propose/re-propose as a guaranteed fresh call isn't viable the way
 * it is for `findFlights`'s free synthetic generator.
 */
const PROVIDER_CACHE_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface ProviderFlightSearchFilter {
  originAirportCode: string;
  destinationAirportCode: string;
  /** Display text for the inserted/matched row's `origin`/`destination` columns (e.g. "New York") — not used for matching, which is airport-code-based. */
  originDisplay: string;
  destinationDisplay: string;
  originId?: string | null;
  destinationId?: string | null;
  /** ISO date (YYYY-MM-DD) in the origin airport's own local time. */
  departureDate: string;
  maxPriceUsd?: number;
  excludeRedEye?: boolean;
  inventoryVersion?: number;
}

async function queryCachedProviderFlights(
  supabase: SupabaseClient<Database>,
  providerName: string,
  filter: ProviderFlightSearchFilter,
): Promise<Flight[]> {
  const requested = new Date(`${filter.departureDate}T00:00:00Z`).getTime();
  const data = await unwrapOrThrow(
    supabase
      .from("flights")
      .select("*")
      .eq("source", providerName)
      .eq("origin_airport_code", filter.originAirportCode)
      .eq("destination_airport_code", filter.destinationAirportCode)
      .eq("inventory_version", filter.inventoryVersion ?? CURRENT_INVENTORY_VERSION)
      // Same UTC-day-widen-then-local-filter approach as `queryRealFlights` —
      // see that function's own comment for why a bare UTC day-boundary
      // query isn't safe here.
      .gte("departure_time", new Date(requested - ONE_DAY_MS).toISOString())
      .lt("departure_time", new Date(requested + 2 * ONE_DAY_MS).toISOString())
      .gte("created_at", new Date(Date.now() - PROVIDER_CACHE_WINDOW_MS).toISOString())
      .order("price_usd", { ascending: true }),
  );
  return data.filter(
    (flight) =>
      localDateInTimeZone(flight.departure_time, flight.departure_time_zone ?? "UTC") === filter.departureDate &&
      matchesRequestedFilter(flight, filter),
  );
}

/**
 * The live-provider equivalent of `findFlights` above, for the app's
 * SerpAPI-only flight search (`src/workflow/flight-step.ts` calls this
 * instead of `findFlights` when a `FlightSearchProvider` is configured —
 * the seed-backed path evals use is completely untouched). Checks the cache
 * first (`queryCachedProviderFlights`), and only calls the real provider
 * (a real, metered, rate-limited HTTP request) on a genuine miss — mirrors
 * `findFlights`'s own "insert what's found, with a `source` tag, so the
 * same route+date is consistent afterward" pattern exactly, just backed by
 * a real API instead of a synthetic generator.
 */
export async function findFlightsFromProvider(
  supabase: SupabaseClient<Database>,
  provider: FlightSearchProvider,
  filter: ProviderFlightSearchFilter,
): Promise<Flight[]> {
  const cached = await queryCachedProviderFlights(supabase, provider.name, filter);
  if (cached.length > 0) return cached;

  const results = await provider.search({
    originAirportCode: filter.originAirportCode,
    destinationAirportCode: filter.destinationAirportCode,
    departureDate: filter.departureDate,
  });
  if (results.length === 0) return [];

  const inventoryVersion = filter.inventoryVersion ?? CURRENT_INVENTORY_VERSION;
  const rowsToInsert: Database["public"]["Tables"]["flights"]["Insert"][] = results.map((option) => ({
    origin: filter.originDisplay,
    origin_id: filter.originId ?? null,
    destination: filter.destinationDisplay,
    destination_id: filter.destinationId ?? null,
    origin_airport_code: filter.originAirportCode,
    destination_airport_code: filter.destinationAirportCode,
    inventory_version: inventoryVersion,
    source: provider.name,
    ...option,
  }));

  const inserted = await unwrapOrThrow(
    supabase.from("flights").insert(rowsToInsert).select("*").order("price_usd", { ascending: true }),
  );
  return inserted.filter((flight) => matchesRequestedFilter(flight, filter));
}

/** Looks up flights already known by ID (e.g. re-hydrating a `trip_decisions` selection) — no destination/date filtering, since the caller already knows exactly which rows it wants. */
export async function getFlightsByIds(
  supabase: SupabaseClient<Database>,
  ids: string[],
): Promise<Flight[]> {
  if (ids.length === 0) return [];
  return unwrapOrThrow(supabase.from("flights").select("*").in("id", ids));
}
