import { describe, expect, it } from "vitest";
import {
  COUNTRY_PROFILES,
  countryProfile,
  dailyCostRangeUsd,
  deriveSeasonality,
  deriveVibeTags,
  haulMultiplier,
} from "./geography";

describe("geography", () => {
  it("throws for a country with no profile", () => {
    expect(() => countryProfile("Nowhere Land")).toThrow(/No CountryProfile/);
  });

  it("returns a profile for every configured country", () => {
    for (const country of Object.keys(COUNTRY_PROFILES)) {
      expect(countryProfile(country)).toBeDefined();
    }
  });

  it("dailyCostRangeUsd returns an ordered, positive range", () => {
    const [low, high] = dailyCostRangeUsd("Japan");
    expect(low).toBeGreaterThan(0);
    expect(high).toBeGreaterThan(low);
  });

  it("deriveSeasonality returns four best months for every country", () => {
    for (const country of Object.keys(COUNTRY_PROFILES)) {
      const { best_months } = deriveSeasonality(country);
      expect(best_months.length).toBeGreaterThan(0);
      for (const month of best_months) {
        expect(month).toBeGreaterThanOrEqual(1);
        expect(month).toBeLessThanOrEqual(12);
      }
    }
  });

  it("deriveVibeTags returns unique, non-empty tags", () => {
    const tags = deriveVibeTags("Thailand");
    expect(tags.length).toBeGreaterThan(0);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("haulMultiplier is defined and positive for every country", () => {
    for (const country of Object.keys(COUNTRY_PROFILES)) {
      expect(haulMultiplier(country)).toBeGreaterThan(0);
    }
  });
});
