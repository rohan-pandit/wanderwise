import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";

export type Flight = Database["public"]["Tables"]["flights"]["Row"];

export interface FlightSearchFilter {
  origin: string;
  destination: string;
  /** ISO date (YYYY-MM-DD) — matches departures on this calendar day. */
  departureDate?: string;
  maxPriceUsd?: number;
  excludeRedEye?: boolean;
  inventoryVersion?: number;
}

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
    .eq("origin", filter.origin)
    .eq("destination", filter.destination);

  if (filter.departureDate) {
    const start = `${filter.departureDate}T00:00:00Z`;
    const end = `${filter.departureDate}T23:59:59Z`;
    query = query.gte("departure_time", start).lte("departure_time", end);
  }
  if (filter.maxPriceUsd !== undefined) {
    query = query.lte("price_usd", filter.maxPriceUsd);
  }
  if (filter.excludeRedEye) {
    query = query.eq("is_red_eye", false);
  }
  if (filter.inventoryVersion !== undefined) {
    query = query.eq("inventory_version", filter.inventoryVersion);
  }

  const { data, error } = await query.order("price_usd", { ascending: true });
  if (error) throw error;
  return data;
}
