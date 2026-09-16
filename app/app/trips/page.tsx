import Link from "next/link";
import { createClient } from "@/src/config/supabase/server";

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

  return (
    <div className="flex flex-1 flex-col px-6 py-8">
      <h1 className="text-lg font-semibold text-black dark:text-zinc-50">
        Your trips
      </h1>

      {error ? (
        <p className="mt-4 text-sm text-red-600 dark:text-red-400">
          Couldn&apos;t load trips: {error.message}
        </p>
      ) : !trips || trips.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
          No trips yet.{" "}
          <Link href="/app" className="underline">
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
                className="flex items-center justify-between rounded-lg border border-zinc-200 px-4 py-3 text-sm hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
              >
                <span className="text-black dark:text-zinc-50">
                  Trip {trip.id.slice(0, 8)}
                </span>
                <span className="text-zinc-500 dark:text-zinc-400">
                  {trip.status}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
