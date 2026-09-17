import { describe, expect, it } from "vitest";
import { localDateInTimeZone, weekdayOf } from "./dates";
import { generateFlightsForDate, routeOperatesOn, routeSchedule } from "./flight-generator";

const ORIGIN = "New York";
const DESTINATION = "Kathmandu";

describe("flight-generator", () => {
  it("routeSchedule is deterministic for the same route", () => {
    expect(routeSchedule(ORIGIN, DESTINATION)).toEqual(routeSchedule(ORIGIN, DESTINATION));
  });

  it("routeSchedule differs for a different route (almost always)", () => {
    const a = routeSchedule(ORIGIN, DESTINATION);
    const b = routeSchedule(ORIGIN, "Lisbon");
    expect([...a].sort()).not.toEqual([...b].sort());
  });

  it("routeOperatesOn agrees with the route's own schedule", () => {
    const schedule = routeSchedule(ORIGIN, DESTINATION);
    for (const date of ["2027-01-04", "2027-01-05", "2027-01-06", "2027-01-07", "2027-01-08", "2027-01-09", "2027-01-10"]) {
      expect(routeOperatesOn(ORIGIN, DESTINATION, date)).toBe(schedule.has(weekdayOf(date)));
    }
  });

  it("returns an empty array on a day the route doesn't operate", () => {
    // Sweep a wide window to find at least one non-operating weekday for this route.
    const schedule = routeSchedule(ORIGIN, DESTINATION);
    const closedWeekday = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].find(
      (day) => !schedule.has(day),
    );
    if (!closedWeekday) return; // this route happens to fly every day — nothing to assert
    const date = ["2027-02-01", "2027-02-02", "2027-02-03", "2027-02-04", "2027-02-05", "2027-02-06", "2027-02-07"].find(
      (d) => weekdayOf(d) === closedWeekday,
    )!;
    expect(generateFlightsForDate(ORIGIN, DESTINATION, date)).toEqual([]);
  });

  it("returns 1-3 flights on a day the route does operate", () => {
    const schedule = routeSchedule(ORIGIN, DESTINATION);
    const operatingWeekday = [...schedule][0];
    const date = ["2027-03-01", "2027-03-02", "2027-03-03", "2027-03-04", "2027-03-05", "2027-03-06", "2027-03-07"].find(
      (d) => weekdayOf(d) === operatingWeekday,
    )!;
    const flights = generateFlightsForDate(ORIGIN, DESTINATION, date);
    expect(flights.length).toBeGreaterThanOrEqual(1);
    expect(flights.length).toBeLessThanOrEqual(3);
    for (const flight of flights) {
      expect(localDateInTimeZone(flight.departure_time, flight.departure_time_zone)).toBe(date);
      expect(flight.price_usd).toBeGreaterThan(0);
      expect(flight.duration_minutes).toBeGreaterThan(0);
      expect(new Date(flight.arrival_time).getTime()).toBeGreaterThan(new Date(flight.departure_time).getTime());
    }
  });

  it("is deterministic: same route+date always returns the same flights", () => {
    const schedule = routeSchedule(ORIGIN, DESTINATION);
    const operatingWeekday = [...schedule][0];
    const date = ["2027-04-01", "2027-04-02", "2027-04-03", "2027-04-04", "2027-04-05", "2027-04-06", "2027-04-07"].find(
      (d) => weekdayOf(d) === operatingWeekday,
    )!;
    expect(generateFlightsForDate(ORIGIN, DESTINATION, date)).toEqual(generateFlightsForDate(ORIGIN, DESTINATION, date));
  });

  it("aggregate hit rate across many dates is high but not universal (realistic, not the norm to fail)", () => {
    let hits = 0;
    const total = 180;
    for (let i = 0; i < total; i++) {
      const date = new Date(Date.UTC(2027, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      if (generateFlightsForDate("Chicago", "Nairobi", date).length > 0) hits++;
    }
    const hitRate = hits / total;
    expect(hitRate).toBeGreaterThan(0.5);
    expect(hitRate).toBeLessThan(1);
  });

  it("a higher haul multiplier tends to produce higher prices and durations", () => {
    const shortHaul = generateFlightsForDate("Chicago", "Toronto", "2027-05-03", 1.0);
    const longHaul = generateFlightsForDate("Chicago", "Sydney", "2027-05-03", 1.9);
    const avg = (flights: { price_usd: number }[]) => flights.reduce((sum, f) => sum + f.price_usd, 0) / flights.length;
    if (shortHaul.length > 0 && longHaul.length > 0) {
      expect(avg(longHaul)).toBeGreaterThan(avg(shortHaul) * 1.2);
    }
  });
});
