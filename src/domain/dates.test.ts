import { describe, expect, it } from "vitest";
import {
  dateRange,
  daysBetween,
  InvalidDateRangeError,
  isWithinRange,
  nightsBetween,
  rangesOverlap,
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
});
