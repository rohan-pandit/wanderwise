"use client";

/**
 * Renders the "Qualitative feedback" section's data (`page.tsx` does the
 * fetching/joining server-side — this only filters/displays what it's
 * given). A small client island rather than the whole page, since
 * kind/category filtering is the one genuinely interactive piece here.
 */
import { useMemo, useState } from "react";
import {
  FEEDBACK_CATEGORY_OPTIONS,
  FEEDBACK_KIND_OPTIONS,
  feedbackCategoryLabel,
  feedbackKindLabel,
} from "@/src/domain/feedback-categories";

export interface FeedbackEntryView {
  id: string;
  /** "bug" / "idea" / "other" — `FEEDBACK_KIND_OPTIONS`. */
  kind: string;
  categories: string[];
  message: string | null;
  /** "chain step: flight" / "finalized" / "cancelled" / "no trip" — see `submitFeedback`'s docstring. */
  context: string;
  /** The /app path the reporter was on, as their client reported it — `null` for reports from before migration 0020, or a path that failed `sanitizeFeedbackRoute`. */
  route: string | null;
  createdAt: string;
  /** False for a report sent from outside any trip (e.g. /app/trips) — no trip context to expand. */
  hasTrip: boolean;
  tripName: string | null;
  /** Destination/dates/party/budget as of now, or `null` if there's no trip or it has no requirements recorded at all — see `summarizeRequirements` (`page.tsx`). */
  requirementsSummary: string | null;
  /** The trip's full chat transcript — the agent's own responses, alongside whatever the user typed. */
  messages: { role: string; content: string }[];
}

/** `kind:<value>` or `category:<value>`, or `all` — one filter row covering both dimensions. */
type Filter = string;

const KIND_BADGE: Record<string, string> = {
  bug: "bg-terracotta-50 text-terracotta-700",
  idea: "bg-teal-50 text-teal-800",
  other: "bg-navy-50 text-navy-700",
};

export function FeedbackList({ entries, thisWeekCount }: { entries: FeedbackEntryView[]; thisWeekCount: number }) {
  const [activeFilter, setActiveFilter] = useState<Filter>("all");

  const { kindCounts, categoryCounts } = useMemo(() => {
    const kinds = new Map<string, number>();
    const categories = new Map<string, number>();
    for (const entry of entries) {
      kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
      for (const category of entry.categories) categories.set(category, (categories.get(category) ?? 0) + 1);
    }
    return { kindCounts: kinds, categoryCounts: categories };
  }, [entries]);

  const filterOptions = [
    { value: "all", label: `All (${entries.length})` },
    ...FEEDBACK_KIND_OPTIONS.filter((opt) => (kindCounts.get(opt.value) ?? 0) > 0).map((opt) => ({
      value: `kind:${opt.value}`,
      label: `${opt.label} (${kindCounts.get(opt.value)})`,
    })),
    ...FEEDBACK_CATEGORY_OPTIONS.filter((opt) => (categoryCounts.get(opt.value) ?? 0) > 0).map((opt) => ({
      value: `category:${opt.value}`,
      label: `${opt.label} (${categoryCounts.get(opt.value)})`,
    })),
  ];

  const visibleEntries = entries.filter((entry) => {
    if (activeFilter === "all") return true;
    const [dimension, value] = activeFilter.split(":");
    return dimension === "kind" ? entry.kind === value : entry.categories.includes(value);
  });

  const kindSplit = FEEDBACK_KIND_OPTIONS.map((opt) => kindCounts.get(opt.value) ?? 0).join(" · ");

  return (
    <div className="mt-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label="Total reports" value={String(entries.length)} />
        <StatTile label="This week" value={String(thisWeekCount)} />
        <StatTile label="Bugs · Ideas · Other" value={kindSplit} />
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
        {visibleEntries.length === 0 ? <p className="py-6 text-center text-sm text-navy-400">No feedback matches this filter.</p> : null}
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
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${KIND_BADGE[entry.kind] ?? KIND_BADGE.other}`}>
            {feedbackKindLabel(entry.kind)}
          </span>
          {entry.categories.map((category) => (
            <span key={category} className="rounded-full bg-sand-100 px-2.5 py-0.5 text-xs text-navy-700">
              {feedbackCategoryLabel(category)}
            </span>
          ))}
          <span className="text-xs text-navy-400">{new Date(entry.createdAt).toLocaleString()}</span>
        </div>
        <span className="text-xs text-navy-400 italic">
          {entry.hasTrip ? `${entry.tripName ?? "Untitled trip"} · ${entry.context}` : "No trip"}
          {entry.route ? ` · ${entry.route}` : ""}
        </span>
      </div>

      {entry.message ? (
        <p className="mt-2 text-sm whitespace-pre-wrap text-navy-900">{entry.message}</p>
      ) : (
        <p className="mt-2 text-sm text-navy-400 italic">No free-text description.</p>
      )}

      {entry.hasTrip ? (
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
      ) : null}
    </div>
  );
}
