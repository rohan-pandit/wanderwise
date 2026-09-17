"use client";

/**
 * The live itinerary panel (PROJECT_BRIEF.md §14, Phase 7) — the other half
 * of the core product experience alongside `chat-panel.tsx`. Renders
 * `trip_decisions` as they're written, live, via a Supabase Realtime
 * subscription (`postgres_changes` INSERT on `trip_decisions`/`trip_events`,
 * filtered to this trip) — not a poll, not a spinner-then-reveal. Both
 * tables already have owner-scoped RLS (`supabase/migrations/0001_initial_schema.sql`),
 * so the anon-key browser client only ever receives this user's own rows.
 *
 * Requires `trip_decisions`/`trip_events` to be in the `supabase_realtime`
 * publication (`supabase/migrations/0007_realtime_trip_updates.sql`, applied).
 */
import { useEffect, useState } from "react";
import { createClient } from "@/src/config/supabase/client";

interface ScheduledActivityDecision {
  id: string;
  date: string;
  startMinutes: number;
  durationMinutes: number;
}

interface BudgetDecision {
  totalEstimate?: { amount: number; currency: string };
  remaining?: { amount: number; currency: string };
  violations?: { message: string }[];
}

type DecisionValue = string | ScheduledActivityDecision[] | BudgetDecision | undefined;

const STEPS: { field: string; label: string }[] = [
  { field: "outboundFlight", label: "Flight" },
  { field: "returnFlight", label: "Return flight" },
  { field: "hotel", label: "Hotel" },
  { field: "activities", label: "Activities" },
  { field: "itineraryText", label: "Itinerary written" },
];

function formatMoney(m?: { amount: number; currency: string }): string | null {
  if (!m) return null;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency }).format(m.amount);
}

function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const period = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

export function ItineraryPanel({ tripId }: { tripId: string }) {
  const [decisions, setDecisions] = useState<Record<string, DecisionValue>>({});
  const [needsAttention, setNeedsAttention] = useState<string | null>(null);
  const [initialLoad, setInitialLoad] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      // `createClient()` returns synchronously, but the session it restores
      // from cookies hydrates asynchronously — waiting for it first (needed
      // for the subscription below too, which authenticates the same way)
      // avoids querying ahead of it as the anon role, which RLS would
      // otherwise narrow to zero rows with no error to explain why.
      await supabase.auth.getSession();
      if (cancelled) return;

      const { data, error } = await supabase
        .from("trip_decisions")
        .select("field, value")
        .eq("trip_id", tripId)
        .neq("status", "superseded");
      if (error) console.error("initial trip_decisions fetch failed:", error);
      if (!cancelled) {
        if (data) setDecisions(Object.fromEntries(data.map((row) => [row.field, row.value as DecisionValue])));
        setInitialLoad(false);
      }
    })();

    const channel = supabase
      .channel(`trip-${tripId}-decisions`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "trip_decisions", filter: `trip_id=eq.${tripId}` },
        (payload) => {
          const row = payload.new as { field: string; value: DecisionValue };
          setDecisions((prev) => ({ ...prev, [row.field]: row.value }));
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "trip_events", filter: `trip_id=eq.${tripId}` },
        (payload) => {
          const row = payload.new as { event_type: string };
          if (row.event_type === "recoverable_error" || row.event_type === "itinerary_invalid") {
            setNeedsAttention(
              row.event_type === "recoverable_error"
                ? "No matching flights/hotels were found for this trip — try adjusting the dates or budget."
                : "That combination didn't work out — trying again with different options.",
            );
          } else {
            setNeedsAttention(null);
          }
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [tripId]);

  const itineraryText = typeof decisions.itineraryText === "string" ? decisions.itineraryText : null;
  const budget = decisions.budget as BudgetDecision | undefined;
  const totalEstimate = formatMoney(budget?.totalEstimate);
  const activities = Array.isArray(decisions.activities) ? (decisions.activities as ScheduledActivityDecision[]) : null;

  return (
    <aside className="flex w-96 flex-shrink-0 flex-col overflow-y-auto border-l border-zinc-200 px-6 py-6 dark:border-zinc-800">
      <h2 className="text-sm font-semibold text-black dark:text-zinc-50">Your itinerary</h2>

      <ul className="mt-4 flex flex-col gap-2">
        {STEPS.map((step) => {
          const done = decisions[step.field] !== undefined;
          return (
            <li key={step.field} className="flex items-center gap-2 text-sm">
              <span
                className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${
                  done ? "bg-black text-white dark:bg-zinc-50 dark:text-black" : "border border-zinc-300 dark:border-zinc-700"
                }`}
              >
                {done ? "✓" : ""}
              </span>
              <span className={done ? "text-black dark:text-zinc-50" : "text-zinc-400 dark:text-zinc-600"}>{step.label}</span>
            </li>
          );
        })}
      </ul>

      {needsAttention ? (
        <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          {needsAttention}
        </p>
      ) : null}

      {totalEstimate ? (
        <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
          Estimated total: <span className="font-medium text-black dark:text-zinc-50">{totalEstimate}</span>
        </p>
      ) : null}

      {activities && activities.length > 0 && !itineraryText ? (
        <ul className="mt-3 flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400">
          {[...activities]
            .sort((a, b) => (a.date === b.date ? a.startMinutes - b.startMinutes : a.date < b.date ? -1 : 1))
            .map((a) => (
              <li key={a.id}>
                {a.date} · {formatTime(a.startMinutes)}
              </li>
            ))}
        </ul>
      ) : null}

      {itineraryText ? (
        <div className="mt-4 whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-300">{itineraryText}</div>
      ) : (
        <p className="mt-4 text-sm text-zinc-400 dark:text-zinc-600">
          {initialLoad
            ? "Loading your itinerary…"
            : "Once your trip details are complete, your itinerary will fill in here as it comes together."}
        </p>
      )}
    </aside>
  );
}
