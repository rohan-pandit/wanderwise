import Link from "next/link";
import { createClient } from "@/src/config/supabase/server";
import { getCurrentChainStep, type ChainDecision } from "@/src/domain/chain";

const CHAIN_STEP_LABELS: Record<ReturnType<typeof getCurrentChainStep>, string> = {
  flight: "Flight",
  hotel: "Hotel",
  activities: "Activities",
  complete: "Complete, not yet finalized",
};

/** `trips.status` never advances past "requirements_ready" under the stepwise chain redesign — steps only ever write `trip_decisions`/`finalizeTrip` writes `finalized`. So progress for an in-flight trip is read from `trip_decisions` instead. */
function describeProgress(status: string, decisions: ChainDecision[]): string {
  if (status === "finalized") return "Finalized";
  if (status === "cancelled") return "Cancelled";
  return CHAIN_STEP_LABELS[getCurrentChainStep(decisions)];
}

/**
 * Trip history list (PROJECT_BRIEF.md §14, IMPLEMENTATION_PLAN.md §4).
 * RLS on `trips` scopes this to the signed-in user automatically —
 * no explicit user_id filter needed here.
 */
export default async function TripsPage() {
  const supabase = await createClient();
  const { data: trips, error } = await supabase
    .from("trips")
    .select("id, status, created_at")
    .order("created_at", { ascending: false });

  const decisionsByTrip = new Map<string, ChainDecision[]>();
  if (trips && trips.length > 0) {
    const { data: decisionRows } = await supabase
      .from("trip_decisions")
      .select("trip_id, field, status")
      .in("trip_id", trips.map((t) => t.id))
      .eq("status", "confirmed");
    for (const row of decisionRows ?? []) {
      const list = decisionsByTrip.get(row.trip_id) ?? [];
      list.push({ field: row.field, status: row.status });
      decisionsByTrip.set(row.trip_id, list);
    }
  }

  return (
    <div className="flex flex-1 flex-col px-6 py-8">
      {/* Same `max-w-2xl` content cap as `chat-panel.tsx`, for the same
          reason — measured at 1440px, this list rendered at ~1377px wide
          with no cap at all, reading as very sparse on a large screen. */}
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="font-serif text-2xl font-semibold text-navy-900">
          Your trips
        </h1>

        {error ? (
          <p className="mt-4 text-sm text-red-600">
            Couldn&apos;t load trips: {error.message}
          </p>
        ) : !trips || trips.length === 0 ? (
          <p className="mt-4 text-sm text-navy-400">
            No trips yet.{" "}
            <Link href="/app" className="text-teal-700 underline hover:text-teal-800">
              Start planning one
            </Link>
            .
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {trips.map((trip) => (
              <li key={trip.id}>
                <Link
                  href={`/app/trips/${trip.id}`}
                  className="flex items-center justify-between rounded-lg border border-sand-200 bg-sand-100 px-4 py-3 text-sm transition-colors hover:border-teal-600"
                >
                  <span className="text-navy-900">
                    Trip {trip.id.slice(0, 8)}
                  </span>
                  <span className="text-navy-400">
                    {describeProgress(trip.status, decisionsByTrip.get(trip.id) ?? [])}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
