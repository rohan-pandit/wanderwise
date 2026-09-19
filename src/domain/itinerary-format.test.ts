import { describe, expect, it } from "vitest";
import { formatFlightTime, formatMoney, formatTime } from "./itinerary-format";

describe("formatMoney", () => {
  it("formats a whole-dollar amount as USD currency", () => {
    expect(formatMoney({ amount: 612, currency: "USD" })).toBe("$612.00");
  });

  it("returns null when no amount is given", () => {
    expect(formatMoney(undefined)).toBeNull();
  });
});

describe("formatTime", () => {
  it("formats a morning time", () => {
    expect(formatTime(11 * 60 + 30)).toBe("11:30 AM");
  });

  it("formats an afternoon time", () => {
    expect(formatTime(14 * 60 + 42)).toBe("2:42 PM");
  });

  it("formats midnight as 12:00 AM", () => {
    expect(formatTime(0)).toBe("12:00 AM");
  });

  it("formats noon as 12:00 PM", () => {
    expect(formatTime(12 * 60)).toBe("12:00 PM");
  });

  it("wraps minutes past 24 hours back into a normal time of day", () => {
    expect(formatTime(24 * 60 + 30)).toBe("12:30 AM");
  });
});

describe("formatFlightTime", () => {
  it("formats an ISO timestamp in the given time zone", () => {
    expect(formatFlightTime("2026-10-02T21:42:00Z", "America/New_York")).toBe("Oct 2, 5:42 PM");
  });

  it("falls back to UTC when no time zone is given", () => {
    expect(formatFlightTime("2026-10-02T21:42:00Z", null)).toBe("Oct 2, 9:42 PM");
  });

  it("returns the raw string unchanged if it can't be parsed", () => {
    expect(formatFlightTime("not-a-date", null)).toBe("not-a-date");
  });
});
