/**
 * Post-sign-in landing (PROJECT_BRIEF.md §14 UX rework, 2026-09-19): the
 * first screen after the magic-link callback, for both a brand-new and a
 * returning user — previously this route rendered a bare, tripless
 * `ChatPanel` directly (the same screen for everyone, no way to tell "start
 * something new" from "resume something existing" apart). Two actions:
 * `/app/new` (name a trip, then chat) or `/app/trips` (the existing trip
 * history list, unchanged).
 */
import Link from "next/link";
import { createClient } from "@/src/config/supabase/server";

export default async function AppHome() {
  const supabase = await createClient();
  const { count } = await supabase.from("trips").select("id", { count: "exact", head: true });
  const tripCount = count ?? 0;

  return (
    <main className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="flex w-full max-w-3xl flex-col items-center text-center">
        <p className="text-xs font-semibold tracking-widest text-teal-700 uppercase">Welcome back</p>
        <h1 className="mt-3 font-serif text-4xl font-semibold text-navy-900">Where are we headed?</h1>
        <p className="mt-3 max-w-md text-base text-navy-400">
          Start a brand-new trip, or pick up right where you left off.
        </p>

        <div className="mt-10 flex flex-col gap-6 sm:flex-row">
          <Link
            href="/app/new"
            className="block w-full rounded-2xl bg-terracotta-600 p-8 text-left transition-colors hover:bg-terracotta-700 sm:w-[340px]"
          >
            <p className="font-serif text-xl font-semibold text-sand-50">Start a new trip</p>
            <p className="mt-2.5 text-sm leading-relaxed text-terracotta-100">
              Tell us where you&apos;re headed and we&apos;ll help you plan every step.
            </p>
            <p className="mt-5 text-sm font-semibold text-sand-50">Get started →</p>
          </Link>

          <Link
            href="/app/trips"
            className="block w-full rounded-2xl border border-sand-300 bg-sand-100 p-8 text-left transition-colors hover:border-teal-600 sm:w-[340px]"
          >
            <p className="font-serif text-xl font-semibold text-navy-900">Review your trips</p>
            <p className="mt-2.5 text-sm leading-relaxed text-navy-400">
              {tripCount > 0
                ? `${tripCount} trip${tripCount === 1 ? "" : "s"} in progress or already finalized.`
                : "You haven't started any trips yet."}
            </p>
            <p className="mt-5 text-sm font-semibold text-teal-700">View trips →</p>
          </Link>
        </div>
      </div>
    </main>
  );
}
