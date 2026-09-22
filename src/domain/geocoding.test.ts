import { describe, expect, it } from "vitest";
import { findCityCoordinates } from "./geocoding";

describe("findCityCoordinates", () => {
  it("finds a well-known city's real coordinates", () => {
    const result = findCityCoordinates("Sintra");
    expect(result).not.toBeNull();
    expect(result?.country).toBe("Portugal");
    expect(result?.lat).toBeCloseTo(38.8, 0);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(findCityCoordinates("  sintra  ")).not.toBeNull();
  });

  it("returns null when a country is given but no candidate matches it — never falls back to a same-named place in a different country", () => {
    // Real live bug (2026-09-22): "Tuscany" (a region, not a populated
    // place — no real match anywhere) used to fall through to a same-named
    // Calgary, Canada neighborhood when "Italy" didn't match anything,
    // silently resolving a European trip's destination to North America.
    expect(findCityCoordinates("Tuscany", "Italy")).toBeNull();
  });

  it("resolves the same bare name differently depending on which country is given", () => {
    const uk = findCityCoordinates("London", "United Kingdom");
    const canada = findCityCoordinates("London", "Canada");
    expect(uk?.country).toBe("United Kingdom");
    expect(canada?.country).toBe("Canada");
    expect(uk?.lat).not.toBeCloseTo(canada?.lat ?? 0, 0);
  });

  it("returns null for a city that doesn't exist in the dataset at all", () => {
    expect(findCityCoordinates("Nowheresville")).toBeNull();
  });

  it("resolves a known native-language-name mismatch via the curated alias table (Cologne -> Koeln)", () => {
    const result = findCityCoordinates("Cologne", "Germany");
    expect(result).not.toBeNull();
    expect(result?.country).toBe("Germany");
  });

  it("without a country, returns the highest-population candidate for an ambiguous bare name", () => {
    const result = findCityCoordinates("Paris");
    expect(result?.country).toBe("France");
  });
});
