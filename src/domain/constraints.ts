/**
 * Hard-constraint engine (PROJECT_BRIEF.md §9.5). Hard constraints must be
 * represented structurally and checked by code — never left to a model to
 * "remember" or a prompt to enforce. Each constraint is a small, independently
 * testable predicate over one candidate kind; `filterHardConstraints` just
 * partitions a candidate list by them and records why each rejection happened.
 */
import type { Activity } from "@/src/repositories/activities";
import type { Flight } from "@/src/repositories/flights";
import type { Hotel } from "@/src/repositories/hotels";
import { maxRoomOccupancy, type RoomGroup } from "./rooms";

export interface HardConstraint<T> {
  /** Stable machine-readable identifier, used in violation/guardrail logs. */
  code: string;
  /** Human-readable reason shown when a candidate fails this constraint. */
  describe(): string;
  isSatisfiedBy(candidate: T): boolean;
}

export interface HardConstraintRejection<T> {
  candidate: T;
  code: string;
  reason: string;
}

export interface HardConstraintFilterResult<T> {
  passing: T[];
  rejected: HardConstraintRejection<T>[];
}

/**
 * Applies every constraint to every candidate. A candidate is rejected on the
 * first constraint it fails; `rejected` records which one and why, so the
 * caller can explain "no red-eye flights" style outcomes instead of just
 * silently returning fewer results.
 */
export function filterHardConstraints<T>(
  candidates: T[],
  constraints: HardConstraint<T>[],
): HardConstraintFilterResult<T> {
  const passing: T[] = [];
  const rejected: HardConstraintRejection<T>[] = [];

  for (const candidate of candidates) {
    const failed = constraints.find((c) => !c.isSatisfiedBy(candidate));
    if (failed) {
      rejected.push({ candidate, code: failed.code, reason: failed.describe() });
    } else {
      passing.push(candidate);
    }
  }

  return { passing, rejected };
}

export function noRedEyeConstraint(): HardConstraint<Flight> {
  return {
    code: "NO_RED_EYE",
    describe: () => "Red-eye flights are excluded.",
    isSatisfiedBy: (flight) => !flight.is_red_eye,
  };
}

export function maxFlightPriceConstraint(maxPriceUsd: number): HardConstraint<Flight> {
  return {
    code: "MAX_FLIGHT_PRICE",
    describe: () => `Flight price must not exceed $${maxPriceUsd}.`,
    isSatisfiedBy: (flight) => flight.price_usd <= maxPriceUsd,
  };
}

export function minHotelRatingConstraint(minRating: number): HardConstraint<Hotel> {
  return {
    code: "MIN_HOTEL_RATING",
    describe: () => `Hotel rating must be at least ${minRating}.`,
    isSatisfiedBy: (hotel) => (hotel.rating ?? 0) >= minRating,
  };
}

export function maxHotelPriceConstraint(maxPriceUsd: number): HardConstraint<Hotel> {
  return {
    code: "MAX_HOTEL_PRICE",
    describe: () => `Hotel price must not exceed $${maxPriceUsd} per night.`,
    isSatisfiedBy: (hotel) => hotel.price_per_night_usd <= maxPriceUsd,
  };
}

/**
 * A hotel booking here always books one room *per room group* — so the
 * hotel's `room_capacity` only needs to fit the single largest group (e.g.
 * parents in one room, kids in another: the hotel just needs to sleep
 * whichever group is bigger, not the whole party in one room).
 */
export function roomCapacityConstraint(roomGroups: RoomGroup[]): HardConstraint<Hotel> {
  const required = maxRoomOccupancy(roomGroups);
  return {
    code: "ROOM_CAPACITY",
    describe: () =>
      roomGroups.length > 1
        ? `Each of the ${roomGroups.length} rooms must accommodate its group (largest: ${required}).`
        : `Room must accommodate ${required} traveler(s).`,
    isSatisfiedBy: (hotel) => hotel.room_capacity >= required,
  };
}

/**
 * A hotel might have enough capacity *per room* (`roomCapacityConstraint`)
 * but not enough rooms free to actually book one per room group
 * (docs/IMPLEMENTATION_PLAN.md §5's "does the hotel actually have enough
 * rooms of that type free" gap). Every room group is assumed to book an
 * identical room type — see `roomCapacityConstraint`'s own docstring and the
 * module-level scope note in `src/repositories/hotels.ts` — so this only
 * needs a total-rooms-needed vs. rooms-available comparison, not a per-type
 * bin-pack.
 */
export function roomAvailabilityConstraint(roomGroups: RoomGroup[]): HardConstraint<Hotel> {
  const required = roomGroups.length;
  return {
    code: "ROOM_AVAILABILITY",
    describe: () => `Needs ${required} room(s) available.`,
    isSatisfiedBy: (hotel) => hotel.available_rooms >= required,
  };
}

export function refundableConstraint(): HardConstraint<Hotel> {
  return {
    code: "REFUNDABLE_REQUIRED",
    describe: () => "Hotel must have a refundable cancellation policy.",
    // cancellation_policy is free text (e.g. "Free cancellation up to 48
    // hours before check-in" or "Non-refundable"), not an enum — matching
    // for the literal string "refundable" would reject every real hotel. An
    // unset policy is treated as not (provably) refundable, same as the
    // other constraints below defaulting missing data to "fails."
    isSatisfiedBy: (hotel) =>
      hotel.cancellation_policy !== null &&
      !hotel.cancellation_policy.toLowerCase().includes("non-refundable"),
  };
}

export function requiredAccessibilityConstraint(
  requiredAttributes: string[],
): HardConstraint<Activity> {
  return {
    code: "REQUIRED_ACCESSIBILITY",
    describe: () => `Activity must support: ${requiredAttributes.join(", ")}.`,
    isSatisfiedBy: (activity) =>
      requiredAttributes.every((attr) =>
        (activity.accessibility_attributes ?? []).includes(attr),
      ),
  };
}

/**
 * Generic over any row shape with a `closed_days` column, not just the full
 * `Activity` row — reused as-is by the Phase 5 retrieval layer's
 * `MatchedActivity` (a narrower projection returned by the `match_activities`
 * SQL function), rather than duplicating this logic there.
 */
export function excludeClosedOnDaysConstraint<T extends { closed_days: string[] | null }>(
  closedDays: string[],
): HardConstraint<T> {
  const excluded = new Set(closedDays.map((d) => d.toLowerCase()));
  return {
    code: "EXCLUDE_CLOSED_DAYS",
    describe: () => `Activity must not be closed on: ${closedDays.join(", ")}.`,
    isSatisfiedBy: (activity) =>
      !(activity.closed_days ?? []).some((day) => excluded.has(day.toLowerCase())),
  };
}

/**
 * Restricts activity candidates to a user-chosen set of categories (e.g.
 * "food", "spa", "nightlife" — `src/domain/curation.ts`'s activity
 * preference UI, `docs/IMPLEMENTATION_PLAN.md`). A post-filter, not a SQL
 * parameter, same reasoning as `excludeClosedOnDaysConstraint` above:
 * `match_activities` doesn't filter by category, so this runs in
 * `retrieveActivities` afterward instead of adding a new SQL function
 * parameter for one more filter. Case-insensitive since the seed data's
 * `category` values are consistently lowercase, but user-supplied category
 * keys shouldn't have to match that exactly to be trusted.
 */
export function categoryConstraint<T extends { category: string | null }>(categories: string[]): HardConstraint<T> {
  const allowed = new Set(categories.map((c) => c.toLowerCase()));
  return {
    code: "ACTIVITY_CATEGORY",
    describe: () => `Activity category must be one of: ${categories.join(", ")}.`,
    isSatisfiedBy: (activity) => activity.category !== null && allowed.has(activity.category.toLowerCase()),
  };
}

export function maxActivityPriceConstraint(maxPriceUsd: number): HardConstraint<Activity> {
  return {
    code: "MAX_ACTIVITY_PRICE",
    describe: () => `Activity price must not exceed $${maxPriceUsd}.`,
    isSatisfiedBy: (activity) => activity.price_usd <= maxPriceUsd,
  };
}
