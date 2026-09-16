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

function toEpochDay(isoDate: string): number {
  const epochMs = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(epochMs)) {
    throw new InvalidDateError(isoDate);
  }
  return Math.floor(epochMs / 86_400_000);
}
