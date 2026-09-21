"use client";

/**
 * Renders the "Qualitative feedback" section's data (`page.tsx` does the
 * fetching/joining server-side — this only filters/displays what it's
 * given). A small client island rather than the whole page, since category
 * filtering is the one genuinely interactive piece here.
 */
import { useMemo, useState } from "react";
import { FEEDBACK_CATEGORY_OPTIONS, feedbackCategoryLabel } from "@/src/domain/feedback-categories";

export interface FeedbackEntryView {
  id: string;
  categories: string[];
  message: string | null;
  /** "chain step: flight" / "finalized" / "cancelled" — see `submitFeedback`'s docstring. */
  context: string;
  createdAt: string;
  tripName: string | null;
  /** Destination/dates/party/budget as of now, or `null` if the trip has no requirements recorded at all — see `summarizeRequirements` (`page.tsx`). */
  requirementsSummary: string | null;
  /** The trip's full chat transcript — the agent's own responses, alongside whatever the user typed. */
  messages: { role: string; content: string }[];
}

export function FeedbackList({ entries, thisWeekCount }: { entries: FeedbackEntryView[]; thisWeekCount: number }) {
  const [activeFilter, setActiveFilter] = useState<string>("all");

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      for (const category of entry.categories) counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    return counts;
  }, [entries]);

  const topCategoryLabel = useMemo(() => {
    let best: string | null = null;
    let bestCount = 0;
    for (const [category, count] of categoryCounts) {
      if (count > bestCount) {
        best = category;
        bestCount = count;
      }
    }
    return best ? feedbackCategoryLabel(best) : "—";
  }, [categoryCounts]);

  const filterOptions = [
    { value: "all", label: `All (${entries.length})` },
    ...FEEDBACK_CATEGORY_OPTIONS.filter((opt) => (categoryCounts.get(opt.value) ?? 0) > 0).map((opt) => ({
      value: opt.value,
      label: `${opt.label} (${categoryCounts.get(opt.value)})`,
    })),
  ];

  const visibleEntries = activeFilter === "all" ? entries : entries.filter((entry) => entry.categories.includes(activeFilter));

  return (
    <div className="mt-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label="Total reports" value={String(entries.length)} />
        <StatTile label="This week" value={String(thisWeekCount)} />
        <StatTile label="Most common category" value={topCategoryLabel} />
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {filterOptions.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => setActiveFilter(opt.value)}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              activeFilter === opt.value ? "border-teal-600 bg-teal-50 text-teal-800" : "border-sand-300 text-navy-700 hover:border-teal-600"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-col gap-2.5">
        {visibleEntries.map((entry) => (
          <FeedbackCard key={entry.id} entry={entry} />
        ))}
        {visibleEntries.length === 0 ? <p className="py-6 text-center text-sm text-navy-400">No reports in this category.</p> : null}
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-sand-200 px-4 py-3">
      <div className="text-xs text-navy-400">{label}</div>
      <div className="mt-1 text-xl font-semibold text-navy-900">{value}</div>
    </div>
  );
}

function FeedbackCard({ entry }: { entry: FeedbackEntryView }) {
  return (
    <div className="rounded-lg border border-sand-200 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {entry.categories.length === 0 ? (
            <span className="rounded-full bg-sand-100 px-2.5 py-0.5 text-xs text-navy-400">Uncategorized</span>
          ) : (
            entry.categories.map((category) => (
              <span key={category} className="rounded-full bg-sand-100 px-2.5 py-0.5 text-xs text-navy-700">
                {feedbackCategoryLabel(category)}
              </span>
            ))
          )}
          <span className="text-xs text-navy-400">{new Date(entry.createdAt).toLocaleString()}</span>
        </div>
        <span className="text-xs text-navy-400 italic">
          {entry.tripName ?? "Untitled trip"} · {entry.context}
        </span>
      </div>

      {entry.message ? (
        <p className="mt-2 text-sm text-navy-900">{entry.message}</p>
      ) : (
        <p className="mt-2 text-sm text-navy-400 italic">No free-text description.</p>
      )}

      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-medium text-teal-700 hover:text-teal-800">
          Trip context{entry.requirementsSummary ? ` — ${entry.requirementsSummary}` : ""}
        </summary>
        <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-sand-200 bg-sand-100 p-3">
          {entry.messages.length === 0 ? (
            <p className="text-xs text-navy-400">No messages recorded for this trip.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {entry.messages.map((message, i) => (
                <li key={i} className={`text-xs ${message.role === "user" ? "text-navy-900" : "text-navy-700"}`}>
                  <span className="font-semibold uppercase">{message.role}: </span>
                  <span className="whitespace-pre-wrap">{message.content}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </div>
  );
}
