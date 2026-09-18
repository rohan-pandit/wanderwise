import { describe, expect, it } from "vitest";
import { findAirportByIata, findAirportsForCity } from "./airport-lookup";

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

  it("returns an empty list for a city with no scheduled-commercial airport", () => {
    expect(findAirportsForCity("Nowheresville")).toEqual([]);
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
