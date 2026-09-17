import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import { CURRENT_INVENTORY_VERSION } from "@/src/domain/inventory";
import { localDateInTimeZone } from "@/src/domain/dates";
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
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Relational query layer backing the `search_flights` model-facing tool
 * (PROJECT_BRIEF.md §12.1). This function only does deterministic filtering —
 * hard-constraint enforcement, budget checks, and ranking are separate
 * deterministic services (Phase 2), not folded in here.
 */
export async function findFlights(
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

/** Looks up flights already known by ID (e.g. re-hydrating a `trip_decisions` selection) — no destination/date filtering, since the caller already knows exactly which rows it wants. */
export async function getFlightsByIds(
  supabase: SupabaseClient<Database>,
  ids: string[],
): Promise<Flight[]> {
  if (ids.length === 0) return [];
  return unwrapOrThrow(supabase.from("flights").select("*").in("id", ids));
}
