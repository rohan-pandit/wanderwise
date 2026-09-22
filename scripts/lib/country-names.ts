/**
 * Shared ISO 3166-1 alpha-2 -> display-name normalization for this project's
 * two dataset generators (`generate-airport-data.ts`, from OurAirports;
 * `generate-city-coordinates.ts`, from GeoNames) — both sources give a
 * country as a bare ISO code, and both need it converted to the same full
 * display-name vocabulary `src/domain/geography.ts`'s `COUNTRY_PROFILES` and
 * `destinations.country` already use, so a country name is comparable
 * (`===`) across all three datasets rather than needing its own per-dataset
 * translation at lookup time.
 */

/** Corrects the handful of `Intl.DisplayNames` outputs that don't match this codebase's existing country-name spelling — found by cross-checking every code either source dataset uses against that list. */
const COUNTRY_NAME_OVERRIDES: Record<string, string> = {
  BS: "The Bahamas",
  CI: "Ivory Coast",
  CZ: "Czech Republic",
  HK: "Hong Kong",
  MO: "Macau",
  TR: "Turkey",
};

export function countryName(iso2: string): string {
  if (COUNTRY_NAME_OVERRIDES[iso2]) return COUNTRY_NAME_OVERRIDES[iso2];
  let name: string | undefined;
  try {
    name = new Intl.DisplayNames(["en"], { type: "region" }).of(iso2);
  } catch {
    name = undefined;
  }
  if (!name) return iso2;
  // "Antigua & Barbuda" -> "Antigua and Barbuda", "Myanmar (Burma)" -> "Myanmar".
  return name.replace(/ & /g, " and ").replace(/\s*\([^)]*\)\s*$/, "").trim();
}
