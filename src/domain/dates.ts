/**
 * Normalized date-range type for the domain layer. Dates are ISO date
 * strings (`YYYY-MM-DD`), not Date objects — Date objects carry an implicit
 * time zone and are a common source of off-by-one-day bugs when crossing
 * the client/server boundary. Convert to Date only at the edges (e.g. when
 * calling a browser API), never store one on domain types.
 */
export interface DateRange {
  readonly start: string;
  readonly end: string;
}

export class InvalidDateRangeError extends Error {
  constructor(range: DateRange) {
    super(`Invalid date range: end (${range.end}) is before start (${range.start})`);
    this.name = "InvalidDateRangeError";
  }
}

export class InvalidDateError extends Error {
  constructor(isoDate: string) {
    super(`Invalid ISO date string: "${isoDate}"`);
    this.name = "InvalidDateError";
  }
}

export function dateRange(start: string, end: string): DateRange {
  const range = { start, end };
  if (toEpochDay(end) < toEpochDay(start)) {
    throw new InvalidDateRangeError(range);
  }
  return range;
}

export function nightsBetween(range: DateRange): number {
  return toEpochDay(range.end) - toEpochDay(range.start);
}

export function daysBetween(range: DateRange): number {
  return nightsBetween(range) + 1;
}

/** True if `date` falls within [range.start, range.end], inclusive. */
export function isWithinRange(date: string, range: DateRange): boolean {
  const d = toEpochDay(date);
  return d >= toEpochDay(range.start) && d <= toEpochDay(range.end);
}

/** True if two ranges share at least one day. */
export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  return toEpochDay(a.start) <= toEpochDay(b.end) && toEpochDay(b.start) <= toEpochDay(a.end);
}

/**
 * The local calendar date (YYYY-MM-DD) a UTC timestamp falls on in `timeZone`.
 * Use this instead of slicing an ISO string when a timestamptz has been
 * normalized to UTC and you need the date as the event's own timezone would
 * display it (e.g. a flight's local departure date).
 */
export function localDateInTimeZone(isoTimestamp: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoTimestamp));
}

/** Minutes after local midnight a UTC timestamp falls at in `timeZone`. */
export function localMinutesOfDay(isoTimestamp: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(isoTimestamp));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

export const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** Lowercase weekday name (e.g. "monday") for an ISO calendar date, independent of any timezone. */
export function weekdayOf(isoDate: string): string {
  // Epoch day 0 (1970-01-01) was a Thursday (index 4).
  const index = (((toEpochDay(isoDate) + 4) % 7) + 7) % 7;
  return WEEKDAYS[index];
}

/**
 * Days since the Unix epoch for an ISO calendar date. Exposed so callers that
 * need to compare or offset dates numerically (e.g. converting a date +
 * minutes-of-day into a single sortable instant) don't have to re-parse ISO
 * strings themselves.
 */
const ISO_DATE_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function toEpochDay(isoDate: string): number {
  const match = ISO_DATE_SHAPE.exec(isoDate);
  if (!match) {
    throw new InvalidDateError(isoDate);
  }
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const epochMs = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(epochMs);
  // `Date.UTC`/`Date.parse` silently roll over an out-of-range calendar date
  // (e.g. "2026-02-30" becomes March 2) instead of rejecting it — catch that
  // by checking the constructed date reports back the same y/m/d.
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new InvalidDateError(isoDate);
  }
  return Math.floor(epochMs / 86_400_000);
}
