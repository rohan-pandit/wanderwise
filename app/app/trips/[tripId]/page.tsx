import { notFound } from "next/navigation";
import { createClient } from "@/src/config/supabase/server";

/**
 * A specific trip's chat + itinerary, resumed. RLS enforces ownership —
 * a trip belonging to another user simply won't be returned by this
 * query, so we don't need a separate authorization check here.
 */
export default async function TripPage({
  params,
}: {
  params: Promise<{ tripId: string }>;
}) {
  const { tripId } = await params;
  const supabase = await createClient();
  const { data: trip, error } = await supabase
    .from("trips")
    .select("id, status, created_at")
    .eq("id", tripId)
    .single();

  if (error) {
    // PGRST116 = "no rows returned" from .single() — genuinely not found
    // (or not owned by this user, which RLS makes indistinguishable from
    // not existing). Any other error is a real failure and should surface
    // as one, not be swallowed into a misleading 404.
    if (error.code === "PGRST116") {
      notFound();
    }
    throw error;
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Trip {trip.id.slice(0, 8)} — status: {trip.status}
      </p>
      <p className="text-xs text-zinc-400 dark:text-zinc-600">
        Resumed chat + itinerary view coming in Phase 6/7.
      </p>
    </div>
  );
}
