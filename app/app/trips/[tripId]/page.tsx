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
  const { data: trip } = await supabase
    .from("trips")
    .select("id, status, created_at")
    .eq("id", tripId)
    .single();

  if (!trip) {
    notFound();
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
