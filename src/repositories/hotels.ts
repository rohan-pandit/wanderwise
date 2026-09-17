import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";
import { CURRENT_INVENTORY_VERSION } from "@/src/domain/inventory";
import { hasValues, unwrapOrThrow } from "./shared";

export type Hotel = Database["public"]["Tables"]["hotels"]["Row"];

export interface HotelSearchFilter {
  destination: string;
  maxPricePerNightUsd?: number;
  minRating?: number;
  vibeTags?: string[];
  minRoomCapacity?: number;
  inventoryVersion?: number;
}

/** Relational query layer backing the `search_hotels` model-facing tool. */
export async function findHotels(
  supabase: SupabaseClient<Database>,
  filter: HotelSearchFilter,
): Promise<Hotel[]> {
  let query = supabase
    .from("hotels")
    .select("*")
    .eq("destination", filter.destination)
    .eq("inventory_version", filter.inventoryVersion ?? CURRENT_INVENTORY_VERSION);

  if (filter.maxPricePerNightUsd !== undefined) {
    query = query.lte("price_per_night_usd", filter.maxPricePerNightUsd);
  }
  if (filter.minRating !== undefined) {
    query = query.gte("rating", filter.minRating);
  }
  if (hasValues(filter.vibeTags)) {
    query = query.overlaps("vibe_tags", filter.vibeTags);
  }
  if (filter.minRoomCapacity !== undefined) {
    query = query.gte("room_capacity", filter.minRoomCapacity);
  }

  return unwrapOrThrow(query.order("price_per_night_usd", { ascending: true }));
}

/** Looks up hotels already known by ID (e.g. re-hydrating a `trip_decisions` selection) — no destination filtering, since the caller already knows exactly which rows it wants. */
export async function getHotelsByIds(
  supabase: SupabaseClient<Database>,
  ids: string[],
): Promise<Hotel[]> {
  if (ids.length === 0) return [];
  return unwrapOrThrow(supabase.from("hotels").select("*").in("id", ids));
}
