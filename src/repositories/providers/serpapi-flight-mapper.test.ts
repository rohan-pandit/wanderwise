import { describe, expect, it } from "vitest";
import { FlightProviderError } from "../flight-provider";
import { SERPAPI_NO_RESULTS_ERROR, mapSerpApiResponse } from "./serpapi-flight-mapper";

/** Shaped from a real live probe of the SerpAPI Google Flights endpoint (JFK -> MAD, 2026-11-03), trimmed to what the mapper reads. */
const REAL_SHAPED_RESPONSE = {
  search_metadata: { status: "Success" },
  best_flights: [
    {
      flights: [
        {
          departure_airport: { name: "John F. Kennedy International Airport", id: "JFK", time: "2026-11-03 15:34" },
          arrival_airport: { name: "Boston Logan International Airport", id: "BOS", time: "2026-11-03 16:57" },
          duration: 83,
          airline: "American",
          travel_class: "Economy",
          flight_number: "AA 4618",
        },
        {
          departure_airport: { name: "Boston Logan International Airport", id: "BOS", time: "2026-11-03 19:15" },
          arrival_airport: { name: "Adolfo Suárez Madrid-Barajas Airport", id: "MAD", time: "2026-11-04 08:05" },
          duration: 410,
          airline: "Iberia",
          travel_class: "Economy",
          flight_number: "IB 346",
        },
      ],
      layovers: [{ duration: 138, name: "Boston Logan International Airport", id: "BOS" }],
      total_duration: 631,
      price: 299,
      type: "One way",
    },
  ],
  other_flights: [
    {
      flights: [
        {
          departure_airport: { name: "John F. Kennedy International Airport", id: "JFK", time: "2026-11-03 22:40" },
          arrival_airport: { name: "Adolfo Suárez Madrid-Barajas Airport", id: "MAD", time: "2026-11-04 11:55" },
          duration: 435,
          airline: "Iberia",
          travel_class: "Economy",
          flight_number: "IB 6251",
        },
      ],
      total_duration: 435,
      price: 410,
      type: "One way",
    },
  ],
};

describe("mapSerpApiResponse", () => {
  it("maps a real-shaped response, summarizing a multi-leg itinerary door-to-door", () => {
    const results = mapSerpApiResponse(REAL_SHAPED_RESPONSE, "America/New_York", "Europe/Madrid");

    expect(results).toHaveLength(2);
    const connecting = results.find((r) => r.price_usd === 299)!;
    // Door-to-door: departs JFK (first leg's departure), arrives MAD (last leg's arrival) — the BOS layover in between isn't modeled as its own leg.
    expect(connecting.departure_time).toBe("2026-11-03T20:34:00.000Z"); // 15:34 America/New_York (EST) -> UTC
    expect(connecting.arrival_time).toBe("2026-11-04T07:05:00.000Z"); // 08:05 Europe/Madrid (CET) -> UTC
    expect(connecting.departure_time_zone).toBe("America/New_York");
    expect(connecting.arrival_time_zone).toBe("Europe/Madrid");
    expect(connecting.airline).toBe("American"); // first leg's carrier
    expect(connecting.duration_minutes).toBe(631); // itinerary total, not the first leg's 83
    expect(connecting.refundable).toBe(false);
    expect(connecting.changeable).toBe(false);
    expect(connecting.taxes_fees_usd).toBe(0);
    expect(connecting.is_red_eye).toBe(false); // 15:34 local — not a red-eye

    const nonstop = results.find((r) => r.price_usd === 410)!;
    expect(nonstop.is_red_eye).toBe(true); // 22:40 local departure
  });

  it("returns an empty array for a route with no results, without treating it as an error", () => {
    expect(mapSerpApiResponse({ search_metadata: { status: "Success" } }, "America/New_York", "Europe/Madrid")).toEqual([]);
  });

  it("treats SerpAPI's 'no results' error as an empty result, not a provider failure", () => {
    expect(mapSerpApiResponse({ error: SERPAPI_NO_RESULTS_ERROR }, "America/New_York", "Europe/Lisbon")).toEqual([]);
  });

  it("throws FlightProviderError when SerpAPI reports a genuine error", () => {
    expect(() => mapSerpApiResponse({ error: "Invalid departure_id" }, "America/New_York", "Europe/Madrid")).toThrow(
      FlightProviderError,
    );
  });

  it("throws FlightProviderError for a non-Success status", () => {
    expect(() =>
      mapSerpApiResponse({ search_metadata: { status: "Error" } }, "America/New_York", "Europe/Madrid"),
    ).toThrow(FlightProviderError);
  });

  it("skips a malformed itinerary (missing price/times) rather than failing the whole search", () => {
    const results = mapSerpApiResponse(
      {
        search_metadata: { status: "Success" },
        best_flights: [{ flights: [{ departure_airport: { time: "2026-11-03 10:00" } }] }], // no price, no arrival
        other_flights: [],
      },
      "America/New_York",
      "Europe/Madrid",
    );
    expect(results).toEqual([]);
  });

  it("defaults airline/flight_number/cabin when missing rather than throwing", () => {
    const results = mapSerpApiResponse(
      {
        search_metadata: { status: "Success" },
        best_flights: [
          {
            flights: [
              {
                departure_airport: { time: "2026-11-03 10:00" },
                arrival_airport: { time: "2026-11-03 12:00" },
              },
            ],
            price: 200,
          },
        ],
      },
      "America/New_York",
      "Europe/Madrid",
    );
    expect(results).toHaveLength(1);
    expect(results[0].airline).toBe("Unknown");
    expect(results[0].flight_number).toBe("");
    expect(results[0].cabin).toBe("Economy");
  });
});
