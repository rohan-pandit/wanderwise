import { describe, expect, it } from "vitest";
import {
  dateRange,
  daysBetween,
  InvalidDateError,
  InvalidDateRangeError,
  isWithinRange,
  localDateInTimeZone,
  localMinutesOfDay,
  nightsBetween,
  rangesOverlap,
  toEpochDay,
  weekdayOf,
} from "./dates";

describe("dates", () => {
  it("computes nights between two dates", () => {
    expect(nightsBetween(dateRange("2026-10-01", "2026-10-06"))).toBe(5);
  });

  it("computes days inclusive of both endpoints", () => {
    expect(daysBetween(dateRange("2026-10-01", "2026-10-06"))).toBe(6);
  });

  it("treats a same-day range as zero nights, one day", () => {
    const range = dateRange("2026-10-01", "2026-10-01");
    expect(nightsBetween(range)).toBe(0);
    expect(daysBetween(range)).toBe(1);
  });

  it("rejects an end date before the start date", () => {
    expect(() => dateRange("2026-10-06", "2026-10-01")).toThrow(
      InvalidDateRangeError,
    );
  });

  it("checks whether a date falls within a range", () => {
    const range = dateRange("2026-10-01", "2026-10-06");
    expect(isWithinRange("2026-10-03", range)).toBe(true);
    expect(isWithinRange("2026-10-01", range)).toBe(true);
    expect(isWithinRange("2026-10-06", range)).toBe(true);
    expect(isWithinRange("2026-10-07", range)).toBe(false);
    expect(isWithinRange("2026-09-30", range)).toBe(false);
  });

  it("detects overlapping ranges", () => {
    const a = dateRange("2026-10-01", "2026-10-06");
    const b = dateRange("2026-10-05", "2026-10-10");
    expect(rangesOverlap(a, b)).toBe(true);
    expect(rangesOverlap(b, a)).toBe(true);
  });

  it("detects non-overlapping ranges", () => {
    const a = dateRange("2026-10-01", "2026-10-06");
    const b = dateRange("2026-10-07", "2026-10-10");
    expect(rangesOverlap(a, b)).toBe(false);
  });

  it("treats touching ranges (shared boundary day) as overlapping", () => {
    const a = dateRange("2026-10-01", "2026-10-06");
    const b = dateRange("2026-10-06", "2026-10-10");
    expect(rangesOverlap(a, b)).toBe(true);
  });

  it("rejects an unparseable date string instead of silently producing NaN", () => {
    expect(() => dateRange("2026-10-01", "not-a-date")).toThrow(InvalidDateError);
    expect(() => dateRange("not-a-date", "2026-10-01")).toThrow(InvalidDateError);
  });

  it("computes the local calendar date a UTC timestamp falls on in a given timezone", () => {
    // 2026-10-05T20:10:00-04:00 is 2026-10-06T00:10:00Z
    expect(
      localDateInTimeZone("2026-10-06T00:10:00Z", "America/New_York"),
    ).toBe("2026-10-05");
    expect(localDateInTimeZone("2026-10-06T00:10:00Z", "UTC")).toBe(
      "2026-10-06",
    );
  });

  it("computes minutes after local midnight a UTC timestamp falls at in a given timezone", () => {
    // 2026-10-06T09:00:00Z is 10:00 in Lisbon (UTC+1 in October)
    expect(localMinutesOfDay("2026-10-06T09:00:00Z", "Europe/Lisbon")).toBe(600);
    expect(localMinutesOfDay("2026-10-06T09:00:00Z", "UTC")).toBe(540);
  });

  it("computes the weekday of an ISO calendar date independent of timezone", () => {
    expect(weekdayOf("2026-10-05")).toBe("monday");
    expect(weekdayOf("2026-10-11")).toBe("sunday");
    expect(weekdayOf("1970-01-01")).toBe("thursday");
  });

  it("computes epoch day for an ISO calendar date", () => {
    expect(toEpochDay("1970-01-01")).toBe(0);
    expect(toEpochDay("1970-01-02")).toBe(1);
  });

  it("rejects a calendrically-invalid date instead of silently rolling it over", () => {
    // Date.UTC/Date.parse would otherwise roll "2026-02-30" over to March 2.
    expect(() => toEpochDay("2026-02-30")).toThrow(InvalidDateError);
    expect(() => toEpochDay("2026-04-31")).toThrow(InvalidDateError);
    expect(() => toEpochDay("2026-13-05")).toThrow(InvalidDateError);
  });

  it("accepts a valid leap day", () => {
    expect(() => toEpochDay("2028-02-29")).not.toThrow();
    expect(() => toEpochDay("2027-02-29")).toThrow(InvalidDateError);
  });
});
