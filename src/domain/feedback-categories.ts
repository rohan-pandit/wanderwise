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
