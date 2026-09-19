/**
 * A trip's `destination` requirement is meant to be a specific city — the
 * only granularity `destinations` (and therefore flights/hotels/activities)
 * actually has (`src/repositories/destinations.ts`; no `state`/`region`
 * column exists). Found live 2026-09-19 debugging a real stuck trip: a user
 * said "New Hampshire" (a state, not a city) and got the same generic
 * "we don't have inventory for that destination" dead end as a genuinely
 * unknown city — a materially different, more fixable situation that
 * deserves its own clarification ("which city?"), not the same catch-all
 * message. This is a plain, static, finite list (US states don't change)
 * checked case-insensitively; country-level detection is handled separately
 * in `listDestinationCountries` (`destinations.ts`) since `country` is
 * already a real column there, no hardcoded list needed for that side.
 */
const US_STATE_NAMES = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut",
  "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa",
  "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan",
  "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada",
  "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina",
  "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island",
  "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont",
  "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming",
  "District of Columbia",
] as const;

const US_STATE_NAMES_LOWER = new Set(US_STATE_NAMES.map((s) => s.toLowerCase()));

/**
 * Whether `value` is (case-insensitively, whitespace-tolerant) exactly a US
 * state name — deliberately exact, not substring: "New York" the STATE and
 * "New York City" the destination share a prefix, but only the bare state
 * name itself should trigger a "which city?" clarification instead of the
 * normal fuzzy-match path (`matchDestinationsByName`, `destinations.ts`)
 * that already handles "New York" -> "New York City" as a city shorthand.
 */
export function isUsStateName(value: string): boolean {
  return US_STATE_NAMES_LOWER.has(value.trim().toLowerCase());
}
