/**
 * "Report an issue" category vocabulary — pulled from the recurring issues
 * found across this project's own manual testing
 * (`docs/END_TO_END_TESTING_ISSUES.md`): chat confusion, flight/hotel
 * search failures, activities gaps, stuck/frozen screens, wrong trip
 * details, plus a catch-all. Lives here (not inline in `feedback-widget.tsx`)
 * so both the client-side report form (`app/app`) and the server-rendered
 * internal review list (`app/internal`) share one label set instead of two
 * copies drifting apart.
 */
export interface FeedbackCategoryOption {
  value: string;
  label: string;
}

export const FEEDBACK_CATEGORY_OPTIONS: FeedbackCategoryOption[] = [
  { value: "chat", label: "Confusing or wrong chat response" },
  { value: "flights", label: "Flights not loading or matching" },
  { value: "hotels", label: "Hotels not loading or matching" },
  { value: "activities", label: "Activities didn't work as expected" },
  { value: "stuck", label: "Screen felt stuck or frozen" },
  { value: "details", label: "Wrong dates, budget, or trip details" },
  { value: "other", label: "Something else" },
];

export function feedbackCategoryLabel(value: string): string {
  return FEEDBACK_CATEGORY_OPTIONS.find((opt) => opt.value === value)?.label ?? value;
}

/**
 * Beta feedback's top-level "What kind?" choice (migration 0020's `kind`
 * column, whose check constraint mirrors these values). `categories` above
 * stays a finer-grained, optional breakdown that's only offered for a bug
 * reported from inside a trip — the one case those labels actually describe.
 */
export type FeedbackKind = "bug" | "idea" | "other";

export const FEEDBACK_KIND_OPTIONS: { value: FeedbackKind; label: string }[] = [
  { value: "bug", label: "Something broke" },
  { value: "idea", label: "Idea" },
  { value: "other", label: "Other" },
];

export function isFeedbackKind(value: unknown): value is FeedbackKind {
  return FEEDBACK_KIND_OPTIONS.some((opt) => opt.value === value);
}

export function feedbackKindLabel(value: string): string {
  return FEEDBACK_KIND_OPTIONS.find((opt) => opt.value === value)?.label ?? value;
}

export const FEEDBACK_MESSAGE_MAX_LENGTH = 2000;

/**
 * The reporter's current path, as the client claims it — kept only if it's
 * plausibly one of this app's own `/app` pages (bounded length, no query
 * string or fragment, which could carry anything), otherwise dropped to
 * `null`. Triage context for `/internal/product-metrics`, never used for
 * anything that needs to be trusted.
 */
export function sanitizeFeedbackRoute(route: unknown): string | null {
  if (typeof route !== "string") return null;
  if (route.length > 200) return null;
  if (!/^\/app(\/[A-Za-z0-9._-]+)*\/?$/.test(route)) return null;
  return route;
}
