import { describe, expect, it } from "vitest";
import { dateRange } from "./dates";
import {
  validateItineraryFeasibility,
  type DraftItinerary,
  type ScheduledActivity,
} from "./feasibility";

function baseItinerary(overrides: Partial<DraftItinerary> = {}): DraftItinerary {
  return {
    destinationTimeZone: "Europe/Lisbon",
    tripDateRange: dateRange("2026-10-06", "2026-10-11"),
    outboundFlight: {
      id: "out-1",
      departureTime: "2026-10-05T23:00:00Z", // lands 2026-10-06 10:00 Lisbon time
      arrivalTime: "2026-10-06T09:00:00Z",
      departureTimeZone: "America/New_York",
      arrivalTimeZone: "Europe/Lisbon",
    },
    returnFlight: {
      id: "ret-1",
      departureTime: "2026-10-11T20:00:00Z", // 20:00 UTC = 21:00 Lisbon (UTC+1 in Oct)
      arrivalTime: "2026-10-12T04:00:00Z",
      departureTimeZone: "Europe/Lisbon",
      arrivalTimeZone: "America/New_York",
    },
    hotelStay: { id: "hotel-1", checkIn: "2026-10-06", checkOut: "2026-10-11" },
    scheduledActivities: [],
    ...overrides,
  };
}

function activity(overrides: Partial<ScheduledActivity> = {}): ScheduledActivity {
  return {
    id: "act-1",
    date: "2026-10-07",
    startMinutes: 10 * 60,
    durationMinutes: 180,
    ...overrides,
  };
}

describe("validateItineraryFeasibility", () => {
  it("is valid for a well-formed itinerary with no scheduling conflicts", () => {
    const result = validateItineraryFeasibility(
      baseItinerary({ scheduledActivities: [activity()] }),
    );
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("flags an activity closed on the scheduled weekday", () => {
    // 2026-10-05 is a Monday
    const result = validateItineraryFeasibility(
      baseItinerary({
        tripDateRange: dateRange("2026-10-05", "2026-10-11"),
        hotelStay: { id: "hotel-1", checkIn: "2026-10-05", checkOut: "2026-10-11" },
        scheduledActivities: [
          activity({ id: "monday-closed", date: "2026-10-05", closedDays: ["monday"], startMinutes: 12 * 60 }),
        ],
      }),
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "ACTIVITY_CLOSED", itemId: "monday-closed" }),
    );
  });

  it("accepts a full-day activity that exactly fills its opening hours", () => {
    const result = validateItineraryFeasibility(
      baseItinerary({
        scheduledActivities: [
          activity({
            id: "sintra-day-trip",
            date: "2026-10-07",
            startMinutes: 8 * 60,
            durationMinutes: 480, // 08:00 - 16:00
            openingHours: { wednesday: "08:00-19:00" },
          }),
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("flags an activity scheduled outside its listed opening hours", () => {
    const result = validateItineraryFeasibility(
      baseItinerary({
        scheduledActivities: [
          activity({
            id: "too-early",
            date: "2026-10-07",
            startMinutes: 6 * 60,
            durationMinutes: 60,
            openingHours: { wednesday: "10:00-18:00" },
          }),
        ],
      }),
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "ACTIVITY_OUTSIDE_OPENING_HOURS", itemId: "too-early" }),
    );
  });

  it("flags two overlapping activities on the same day", () => {
    const result = validateItineraryFeasibility(
      baseItinerary({
        scheduledActivities: [
          activity({ id: "first", date: "2026-10-07", startMinutes: 10 * 60, durationMinutes: 120 }),
          activity({ id: "second", date: "2026-10-07", startMinutes: 11 * 60, durationMinutes: 60 }),
        ],
      }),
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "OVERLAPPING_ACTIVITIES", itemId: "second" }),
    );
  });

  it("does not flag back-to-back activities that only touch at the boundary", () => {
    const result = validateItineraryFeasibility(
      baseItinerary({
        scheduledActivities: [
          activity({ id: "first", date: "2026-10-07", startMinutes: 10 * 60, durationMinutes: 120 }),
          activity({ id: "second", date: "2026-10-07", startMinutes: 12 * 60, durationMinutes: 60 }),
        ],
      }),
    );
    expect(result.violations).toEqual([]);
  });

  it("flags an activity scheduled before the arrival transfer buffer", () => {
    const result = validateItineraryFeasibility(
      baseItinerary({
        scheduledActivities: [
          // arrival lands 10:00 local; buffer is 180 min -> earliest 13:00
          activity({ id: "too-soon", date: "2026-10-06", startMinutes: 11 * 60, durationMinutes: 60 }),
        ],
      }),
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "ACTIVITY_BEFORE_ARRIVAL", itemId: "too-soon" }),
    );
  });

  it("warns, but does not block, an activity just past the arrival buffer", () => {
    const result = validateItineraryFeasibility(
      baseItinerary({
        scheduledActivities: [
          activity({ id: "tight", date: "2026-10-06", startMinutes: 13 * 60 + 10, durationMinutes: 60 }),
        ],
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "TIGHT_TRANSFER_BUFFER", itemId: "tight" }),
    );
  });

  it("flags an activity that runs into the departure transfer buffer", () => {
    const result = validateItineraryFeasibility(
      baseItinerary({
        scheduledActivities: [
          // departs 21:00 local Oct 11; buffer 180 min -> must end by 18:00
          activity({ id: "too-late", date: "2026-10-11", startMinutes: 17 * 60 + 30, durationMinutes: 90 }),
        ],
      }),
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "ACTIVITY_AFTER_DEPARTURE", itemId: "too-late" }),
    );
  });

  it("flags an activity scheduled outside the trip dates", () => {
    const result = validateItineraryFeasibility(
      baseItinerary({
        scheduledActivities: [activity({ id: "too-late-in-trip", date: "2026-10-15" })],
      }),
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "ACTIVITY_OUTSIDE_TRIP_DATES", itemId: "too-late-in-trip" }),
    );
  });

  it("flags an activity scheduled outside the hotel stay", () => {
    const result = validateItineraryFeasibility(
      baseItinerary({
        hotelStay: { id: "hotel-1", checkIn: "2026-10-07", checkOut: "2026-10-11" },
        scheduledActivities: [activity({ id: "before-checkin", date: "2026-10-06" })],
      }),
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "ACTIVITY_OUTSIDE_HOTEL_STAY", itemId: "before-checkin" }),
    );
  });

  it("flags a hotel stay that doesn't cover the full trip", () => {
    const result = validateItineraryFeasibility(
      baseItinerary({ hotelStay: { id: "hotel-1", checkIn: "2026-10-07", checkOut: "2026-10-11" } }),
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "HOTEL_DOES_NOT_COVER_TRIP", itemId: "hotel-1" }),
    );
  });

  it("flags the same activity id scheduled twice", () => {
    const result = validateItineraryFeasibility(
      baseItinerary({
        scheduledActivities: [
          activity({ id: "dup", date: "2026-10-07", startMinutes: 9 * 60 }),
          activity({ id: "dup", date: "2026-10-08", startMinutes: 9 * 60 }),
        ],
      }),
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "DUPLICATE_ACTIVITY", itemId: "dup" }),
    );
  });

  it("flags an activity that overlaps an earlier, longer-running activity even when a middle activity sits between them", () => {
    // museum 09:00-17:00, coffee 10:00-10:30 (overlaps museum), gift-shop
    // 15:00-16:00 (overlaps museum but not coffee) — a naive "only compare
    // to the previous activity by start time" sweep would flag coffee but
    // miss gift-shop entirely.
    const result = validateItineraryFeasibility(
      baseItinerary({
        scheduledActivities: [
          activity({ id: "museum", date: "2026-10-07", startMinutes: 9 * 60, durationMinutes: 480 }),
          activity({ id: "coffee", date: "2026-10-07", startMinutes: 10 * 60, durationMinutes: 30 }),
          activity({ id: "gift-shop", date: "2026-10-07", startMinutes: 15 * 60, durationMinutes: 60 }),
        ],
      }),
    );
    const overlapIds = result.violations
      .filter((v) => v.code === "OVERLAPPING_ACTIVITIES")
      .map((v) => v.itemId);
    expect(overlapIds).toEqual(expect.arrayContaining(["coffee", "gift-shop"]));
  });

  it("still checks a duplicated activity's second occurrence for overlaps, rather than skipping it", () => {
    const result = validateItineraryFeasibility(
      baseItinerary({
        scheduledActivities: [
          activity({ id: "other", date: "2026-10-07", startMinutes: 10 * 60, durationMinutes: 60 }),
          activity({ id: "dup", date: "2026-10-07", startMinutes: 9 * 60, durationMinutes: 60 }),
          // second "dup" occurrence overlaps "other"
          activity({ id: "dup", date: "2026-10-07", startMinutes: 10 * 60 + 15, durationMinutes: 30 }),
        ],
      }),
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "DUPLICATE_ACTIVITY", itemId: "dup" }),
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "OVERLAPPING_ACTIVITIES", itemId: "dup" }),
    );
  });

  it("accepts an activity scheduled inside opening hours that cross midnight", () => {
    // Reykjavik "Northern Lights Hunt" fixture: open 21:00-01:00 every day.
    const result = validateItineraryFeasibility(
      baseItinerary({
        scheduledActivities: [
          activity({
            id: "northern-lights",
            date: "2026-10-07",
            startMinutes: 21 * 60 + 30,
            durationMinutes: 120, // 21:30 - 23:30, within 21:00-01:00
            openingHours: {
              monday: "21:00-01:00",
              tuesday: "21:00-01:00",
              wednesday: "21:00-01:00",
              thursday: "21:00-01:00",
              friday: "21:00-01:00",
              saturday: "21:00-01:00",
              sunday: "21:00-01:00",
            },
          }),
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("accepts an early-morning activity covered by the previous day's overnight opening hours", () => {
    const result = validateItineraryFeasibility(
      baseItinerary({
        scheduledActivities: [
          activity({
            id: "northern-lights-late",
            date: "2026-10-08", // Thursday — window opened the night before (Wednesday 21:00-01:00)
            startMinutes: 0 * 60 + 15,
            durationMinutes: 30, // 00:15 - 00:45, before Thursday's own 21:00 opening
            openingHours: {
              wednesday: "21:00-01:00",
              thursday: "21:00-01:00",
            },
          }),
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("flags an activity scheduled outside even a midnight-crossing opening window", () => {
    const result = validateItineraryFeasibility(
      baseItinerary({
        scheduledActivities: [
          activity({
            id: "too-early-for-nightlife",
            date: "2026-10-07",
            startMinutes: 18 * 60,
            durationMinutes: 60, // 18:00-19:00, before the 21:00 opening
            openingHours: { wednesday: "21:00-01:00" },
          }),
        ],
      }),
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "ACTIVITY_OUTSIDE_OPENING_HOURS", itemId: "too-early-for-nightlife" }),
    );
  });

  it("flags an activity on the day before departure that falls inside the departure transfer buffer across midnight", () => {
    // Return flight departs 2026-10-12T04:00Z from Lisbon — an early-morning
    // departure. With a 180-minute buffer, nothing should run in Lisbon
    // local time after 01:00 on the departure day, which reaches back into
    // the evening of 2026-10-11.
    const result = validateItineraryFeasibility(
      baseItinerary({
        tripDateRange: dateRange("2026-10-06", "2026-10-12"),
        hotelStay: { id: "hotel-1", checkIn: "2026-10-06", checkOut: "2026-10-12" },
        returnFlight: {
          id: "ret-1",
          departureTime: "2026-10-12T04:00:00Z", // 05:00 Lisbon time
          arrivalTime: "2026-10-12T12:00:00Z",
          departureTimeZone: "Europe/Lisbon",
          arrivalTimeZone: "America/New_York",
        },
        scheduledActivities: [
          // Starts 23:00 on 2026-10-11 and runs to 03:00 the next calendar
          // day (Lisbon time) — well inside the 180-minute buffer before the
          // 05:00 departure, but scheduled ("date") on the *previous*
          // calendar day from the flight's local departure date (2026-10-12).
          activity({ id: "late-night", date: "2026-10-11", startMinutes: 23 * 60, durationMinutes: 240 }),
        ],
      }),
    );
    expect(result.violations).toContainEqual(
      expect.objectContaining({ code: "ACTIVITY_AFTER_DEPARTURE", itemId: "late-night" }),
    );
  });

  it("warns on an excessively full day without blocking it", () => {
    const result = validateItineraryFeasibility(
      baseItinerary({
        scheduledActivities: [
          activity({ id: "a1", date: "2026-10-07", startMinutes: 8 * 60, durationMinutes: 300 }),
          activity({ id: "a2", date: "2026-10-07", startMinutes: 13 * 60, durationMinutes: 360 }),
        ],
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "EXCESSIVE_DAILY_LOAD" }),
    );
  });
});
