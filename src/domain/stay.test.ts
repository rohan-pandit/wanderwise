import { describe, expect, it } from "vitest";
import { flight } from "@/src/repositories/fixtures";
import { deriveHotelStayDates } from "./stay";

describe("deriveHotelStayDates", () => {
  it("derives check-in from the outbound flight's local arrival date and check-out from the return flight's local departure date", () => {
    const outbound = flight({
      arrival_time: "2026-10-06T09:00:00Z",
      arrival_time_zone: "Europe/Lisbon",
    });
    const returnFlight = flight({
      id: "flight-return",
      departure_time: "2026-10-12T14:00:00Z",
      departure_time_zone: "Europe/Lisbon",
    });

    expect(deriveHotelStayDates(outbound, returnFlight)).toEqual({
      destinationTimeZone: "Europe/Lisbon",
      checkIn: "2026-10-06",
      checkOut: "2026-10-12",
    });
  });

  it("accounts for an overnight flight landing a calendar day after the UTC departure date", () => {
    const outbound = flight({
      // Departs 23:00 UTC, but lands the *next* local day in Lisbon.
      departure_time: "2026-10-05T23:00:00Z",
      arrival_time: "2026-10-06T01:30:00Z",
      arrival_time_zone: "Europe/Lisbon",
    });
    const returnFlight = flight({
      id: "flight-return",
      departure_time: "2026-10-12T14:00:00Z",
      departure_time_zone: "Europe/Lisbon",
    });

    expect(deriveHotelStayDates(outbound, returnFlight).checkIn).toBe("2026-10-06");
  });

  it("defaults to UTC when the outbound flight has no arrival time zone recorded", () => {
    const outbound = flight({ arrival_time: "2026-10-06T09:00:00Z", arrival_time_zone: null });
    const returnFlight = flight({ id: "flight-return", departure_time: "2026-10-12T14:00:00Z" });

    expect(deriveHotelStayDates(outbound, returnFlight).destinationTimeZone).toBe("UTC");
  });
});
