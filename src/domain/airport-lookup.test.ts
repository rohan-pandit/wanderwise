import { describe, expect, it } from "vitest";
import { findAirportByIata, findAirportsForCity, findNearestAirport, findNearestAirportForCity } from "./airport-lookup";

describe("findAirportsForCity", () => {
  it("resolves an unambiguous city to its single airport", () => {
    const result = findAirportsForCity("Madrid");
    expect(result).toHaveLength(1);
    expect(result[0].iata).toBe("MAD");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(findAirportsForCity("  MADRID  ").map((a) => a.iata)).toEqual(["MAD"]);
  });

  it("narrows correctly with 'City, Country'", () => {
    const result = findAirportsForCity("Madrid, Spain");
    expect(result.map((a) => a.iata)).toEqual(["MAD"]);
  });

  it("returns every airport for a city with more than one (same country)", () => {
    const result = findAirportsForCity("New York");
    expect(result.map((a) => a.iata).sort()).toEqual(["JFK", "LGA"]);
  });

  it("returns every airport for a city name shared across countries when no country is given", () => {
    const result = findAirportsForCity("London");
    const countries = new Set(result.map((a) => a.country));
    expect(countries.has("United Kingdom")).toBe(true);
    expect(countries.has("Canada")).toBe(true);
    expect(result.length).toBeGreaterThan(3);
  });

  it("narrows a cross-country city-name collision down with a country", () => {
    const result = findAirportsForCity("London, Canada");
    expect(result).toHaveLength(1);
    expect(result[0].iata).toBe("YXU");
  });

  it("still returns multiple candidates when the same city+country has more than one airport", () => {
    const result = findAirportsForCity("London, United Kingdom");
    expect(result.length).toBeGreaterThanOrEqual(3);
    expect(result.every((a) => a.country === "United Kingdom")).toBe(true);
  });

  it("returns an empty list rather than guessing when the given country doesn't match the city", () => {
    expect(findAirportsForCity("London, France")).toEqual([]);
  });

  it("falls back to the unfiltered city match for a US 'City, State' origin, rather than rejecting it", () => {
    const result = findAirportsForCity("Newark, New Jersey");
    expect(result.map((a) => a.iata)).toEqual(["EWR"]);
  });

  it("returns an empty list for a city with no scheduled-commercial airport", () => {
    expect(findAirportsForCity("Nowheresville")).toEqual([]);
  });
});

describe("findNearestAirport", () => {
  it("finds the closest real airport to a coordinate", () => {
    // Sintra, Portugal's real coordinates — Cascais (CAT) is genuinely
    // closer than Lisbon (LIS), the more obvious guess.
    const result = findNearestAirport(38.80097, -9.37826);
    expect(result.iata).toBe("CAT");
  });

  it("always returns something, even for a coordinate with no nearby airport at all", () => {
    // The middle of the Pacific Ocean.
    const result = findNearestAirport(-10, -160);
    expect(result.iata).toBeTruthy();
  });
});

describe("findNearestAirportForCity", () => {
  it("resolves a real destination with no scheduled-commercial airport of its own (the live Sintra, Portugal case)", () => {
    const result = findNearestAirportForCity("Sintra, Portugal");
    expect(result?.iata).toBe("CAT");
  });

  it("resolves a major city whose only real airport is listed under a mismatched municipality name (Paris)", () => {
    const result = findNearestAirportForCity("Paris, France");
    expect(result?.country).toBe("France");
  });

  it("returns null rather than a wrong-country guess when the country doesn't match anything (the Tuscany regression)", () => {
    expect(findNearestAirportForCity("Tuscany, Italy")).toBeNull();
  });

  it("returns null for a place that doesn't geocode at all", () => {
    expect(findNearestAirportForCity("Nowheresville")).toBeNull();
  });

  it("uses preferredCountry only when the query itself gives no country", () => {
    // "London" alone is ambiguous (UK vs. Canada, among others) — biasing
    // toward Canada should resolve there, not fall through to the
    // highest-population global candidate (London, UK).
    const result = findNearestAirportForCity("London", "Canada");
    expect(result?.country).toBe("Canada");
  });

  it("a country stated in the query itself always wins over preferredCountry", () => {
    const result = findNearestAirportForCity("London, United Kingdom", "Canada");
    expect(result?.country).toBe("United Kingdom");
  });
});

describe("findAirportByIata", () => {
  it("finds an airport by its code, case-insensitively", () => {
    expect(findAirportByIata("mad")?.city).toBe("Madrid");
    expect(findAirportByIata("MAD")?.city).toBe("Madrid");
  });

  it("returns undefined for an unknown code", () => {
    expect(findAirportByIata("ZZZ")).toBeUndefined();
  });
});
