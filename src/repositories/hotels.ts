import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/src/config/supabase/database.types";

export type Hotel = Database["public"]["Tables"]["hotels"]["Row"];

export interface HotelSearchFilter {
  destination: string;
  maxPricePerNightUsd?: number;
  minRating?: number;
  vibeTags?: string[];
  minRoomCapacity?: number;
}

/** Relational query layer backing the `search_hotels` model-facing tool. */
export async function findHotels(
  supabase: SupabaseClient<Database>,
  filter: HotelSearchFilter,
): Promise<Hotel[]> {
  let query = supabase
    .from("hotels")
    .select("*")
    .eq("destination", filter.destination);

  if (filter.maxPricePerNightUsd !== undefined) {
    query = query.lte("price_per_night_usd", filter.maxPricePerNightUsd);
  }
  if (filter.minRating !== undefined) {
    query = query.gte("rating", filter.minRating);
  }
  if (filter.vibeTags && filter.vibeTags.length > 0) {
    query = query.overlaps("vibe_tags", filter.vibeTags);
  }
  if (filter.minRoomCapacity !== undefined) {
    query = query.gte("room_capacity", filter.minRoomCapacity);
  }

  const { data, error } = await query.order("price_per_night_usd", {
    ascending: true,
  });
  if (error) throw error;
  return data;
}
