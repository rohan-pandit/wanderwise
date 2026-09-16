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

function toEpochDay(isoDate: string): number {
  return Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000);
}
