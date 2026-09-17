/**
 * Deterministic synthetic flight generation, used only as a fallback when a
 * real search finds zero rows for a route+date (`src/repositories/flights.ts`'s
 * `findFlights`). Exists because `flights` rows are matched by exact calendar
 * date (`docs/IMPLEMENTATION_PLAN.md`'s large-seed-data session) — at ~640
 * destinations, pre-seeding literal rows for every future date is
 * combinatorially infeasible, but the user explicitly wants realistic,
 * occasional gaps rather than either "always seeded" or "always available."
 *
 * The core idea: a route's *weekly schedule* is deterministic (seeded from
 * the route itself), not a per-date coin flip — real airlines don't fly
 * every route every day either. A specific date has no flight because that
 * route doesn't operate on that weekday, and an adjacent date usually does.
 * Once generated for a given route+date, the caller persists the result, so
 * the same route+date always returns the same flights afterward (this module
 * itself is pure and does no persistence).
 *
 * Deliberately timezone-agnostic: every generated flight uses UTC for both
 * `departure_time_zone`/`arrival_time_zone`, with `departure_time` set
 * exactly on the requested calendar date in UTC — this guarantees
 * `findFlights`'s local-date filtering round-trips correctly without needing
 * a real IANA time zone for an arbitrary origin (often free-text, never a
 * seeded destination) or having to resolve one for the destination side.
 */
import { toEpochDay, weekdayOf, WEEKDAYS } from "./dates";
import { chance, pick, pickMany, randomFloat, randomInt, seededRng, type Rng } from "./random";

export interface GeneratedFlightOption {
  departure_time: string;
  arrival_time: string;
  departure_time_zone: string;
  arrival_time_zone: string;
  airline: string;
  flight_number: string;
  price_usd: number;
  taxes_fees_usd: number;
  cabin: string;
  is_red_eye: boolean;
  duration_minutes: number;
  refundable: boolean;
  changeable: boolean;
}

function routeKey(origin: string, destination: string): string {
  return `route:${origin.trim().toLowerCase()}|${destination.trim().toLowerCase()}`;
}

/**
 * The set of weekdays a route "operates" on — deterministic per route, not
 * per date. Weighted so most routes fly most days (aggregate ~85% of
 * specific dates have at least one option) without ever guaranteeing 100%,
 * per the user's explicit "realistic occasional gaps, not the norm" ask.
 */
export function routeSchedule(origin: string, destination: string): Set<string> {
  const rng = seededRng(routeKey(origin, destination));
  const roll = rng();
  let dayCount: number;
  if (roll < 0.6) dayCount = 7;
  else if (roll < 0.85) dayCount = randomInt(rng, 5, 6);
  else if (roll < 0.95) dayCount = randomInt(rng, 3, 4);
  else dayCount = randomInt(rng, 1, 2);
  return new Set(pickMany(rng, WEEKDAYS, dayCount));
}

export function routeOperatesOn(origin: string, destination: string, isoDate: string): boolean {
  return routeSchedule(origin, destination).has(weekdayOf(isoDate));
}

const AIRLINES: { name: string; code: string }[] = [
  { name: "Skyline Air", code: "SK" },
  { name: "Continental Wings", code: "CW" },
  { name: "Pacific Express", code: "PX" },
  { name: "Atlas Airlines", code: "AT" },
  { name: "Meridian Air", code: "MA" },
  { name: "NorthStar Airlines", code: "NS" },
  { name: "Horizon Airways", code: "HA" },
  { name: "Blue Coast Air", code: "BC" },
];

const CABINS = ["Economy", "Economy", "Economy", "Premium Economy", "Business"];

interface TimeSlot {
  name: string;
  hourRange: [number, number];
}
const TIME_SLOTS: TimeSlot[] = [
  { name: "morning", hourRange: [6, 10] },
  { name: "midday", hourRange: [11, 15] },
  { name: "evening", hourRange: [16, 20] },
  { name: "red_eye", hourRange: [21, 23] },
];

function isoDateAtUtcHour(isoDate: string, hour: number, minute: number): string {
  const epochDay = toEpochDay(isoDate);
  const ms = epochDay * 86_400_000 + hour * 3_600_000 + minute * 60_000;
  return new Date(ms).toISOString();
}

function generateOneFlight(rng: Rng, isoDate: string, slot: TimeSlot, haulMultiplier: number): GeneratedFlightOption {
  const hour = randomInt(rng, slot.hourRange[0], slot.hourRange[1]);
  const minute = pick(rng, [0, 15, 30, 45]);
  const departureTime = isoDateAtUtcHour(isoDate, hour, minute);
  const durationMinutes = Math.max(45, Math.round(90 * haulMultiplier + randomInt(rng, -20, 40)));
  const arrivalTime = new Date(new Date(departureTime).getTime() + durationMinutes * 60_000).toISOString();

  const airline = pick(rng, AIRLINES);
  const weekday = weekdayOf(isoDate);
  const isWeekend = weekday === "friday" || weekday === "saturday" || weekday === "sunday";
  const basePrice = 120 * haulMultiplier;
  const price = Math.round(basePrice * (isWeekend ? 1.15 : 1) * randomFloat(rng, 0.85, 1.25));
  const isRedEye = slot.name === "red_eye" || hour >= 21 || hour < 5;

  return {
    departure_time: departureTime,
    arrival_time: arrivalTime,
    departure_time_zone: "UTC",
    arrival_time_zone: "UTC",
    airline: airline.name,
    flight_number: `${airline.code}${randomInt(rng, 100, 999)}`,
    price_usd: price,
    taxes_fees_usd: Math.round(price * randomFloat(rng, 0.08, 0.15)),
    cabin: pick(rng, CABINS),
    is_red_eye: isRedEye,
    duration_minutes: durationMinutes,
    refundable: chance(rng, 0.2),
    changeable: chance(rng, 0.35),
  };
}

/**
 * Generates 0-3 plausible flights for one route+calendar-date. Returns `[]`
 * when the route's deterministic weekly schedule doesn't operate on that
 * date's weekday — a genuine, realistic "no flight that day," not an error.
 * `haulMultiplier` (see `src/domain/geography.ts`) scales price/duration for
 * a rough long-haul-vs-short-haul feel; callers resolve it from whichever
 * side of the route is a known seeded destination.
 */
export function generateFlightsForDate(
  origin: string,
  destination: string,
  isoDate: string,
  haulMultiplier = 1.3,
): GeneratedFlightOption[] {
  if (!routeOperatesOn(origin, destination, isoDate)) return [];

  const rng = seededRng(`flight:${origin.trim().toLowerCase()}|${destination.trim().toLowerCase()}|${isoDate}`);
  const numFlights = randomInt(rng, 1, 3);
  const slots = pickMany(rng, TIME_SLOTS, numFlights);
  return slots.map((slot) => generateOneFlight(rng, isoDate, slot, haulMultiplier));
}
