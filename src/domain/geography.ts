/**
 * Country-level metadata backing large-scale destination/flight generation
 * (`scripts/generate-large-seed-data.ts`, `src/domain/flight-generator.ts`).
 * Deliberately coarse — one profile per country, not per city — because this
 * is mock inventory for a portfolio app, not a real geodata service: the
 * goal is plausible variety (cost tiers, seasons, rough flight haul), not
 * survey-grade accuracy. Lives in `src/domain/` rather than `scripts/` so
 * both the (script-only) seed generator and the (runtime) flight generator
 * can import the same table without duplicating it.
 */

export type Region =
  | "north_america"
  | "latin_america"
  | "europe"
  | "africa"
  | "middle_east"
  | "south_asia"
  | "east_asia"
  | "southeast_asia"
  | "central_asia"
  | "oceania";

export type ClimateZone = "tropical" | "arid" | "mediterranean" | "temperate" | "cold";

export interface CountryProfile {
  region: Region;
  /** 1 (cheapest) - 5 (most expensive) — a rough cost-of-living/travel-cost tier, not a real index. */
  costTier: 1 | 2 | 3 | 4 | 5;
  climateZone: ClimateZone;
  /** One representative IANA time zone for the whole country — a simplification for large countries. */
  timeZone: string;
}

const P = (region: Region, costTier: 1 | 2 | 3 | 4 | 5, climateZone: ClimateZone, timeZone: string): CountryProfile => ({
  region,
  costTier,
  climateZone,
  timeZone,
});

export const COUNTRY_PROFILES: Record<string, CountryProfile> = {
  // North America
  "United States": P("north_america", 4, "temperate", "America/New_York"),
  Canada: P("north_america", 4, "cold", "America/Toronto"),
  Mexico: P("north_america", 2, "arid", "America/Mexico_City"),

  // Central America / Caribbean
  Guatemala: P("latin_america", 1, "tropical", "America/Guatemala"),
  Belize: P("latin_america", 2, "tropical", "America/Belize"),
  "Costa Rica": P("latin_america", 3, "tropical", "America/Costa_Rica"),
  Panama: P("latin_america", 3, "tropical", "America/Panama"),
  Honduras: P("latin_america", 1, "tropical", "America/Tegucigalpa"),
  "El Salvador": P("latin_america", 2, "tropical", "America/El_Salvador"),
  Nicaragua: P("latin_america", 1, "tropical", "America/Managua"),
  Cuba: P("latin_america", 2, "tropical", "America/Havana"),
  Jamaica: P("latin_america", 3, "tropical", "America/Jamaica"),
  "Dominican Republic": P("latin_america", 2, "tropical", "America/Santo_Domingo"),
  "Puerto Rico": P("latin_america", 3, "tropical", "America/Puerto_Rico"),
  "The Bahamas": P("latin_america", 4, "tropical", "America/Nassau"),
  Barbados: P("latin_america", 4, "tropical", "America/Barbados"),
  "Trinidad and Tobago": P("latin_america", 3, "tropical", "America/Port_of_Spain"),

  // South America
  Colombia: P("latin_america", 2, "tropical", "America/Bogota"),
  Venezuela: P("latin_america", 1, "tropical", "America/Caracas"),
  Ecuador: P("latin_america", 2, "tropical", "America/Guayaquil"),
  Peru: P("latin_america", 2, "arid", "America/Lima"),
  Bolivia: P("latin_america", 1, "cold", "America/La_Paz"),
  Chile: P("latin_america", 3, "arid", "America/Santiago"),
  Argentina: P("latin_america", 2, "temperate", "America/Argentina/Buenos_Aires"),
  Uruguay: P("latin_america", 3, "temperate", "America/Montevideo"),
  Paraguay: P("latin_america", 1, "tropical", "America/Asuncion"),
  Brazil: P("latin_america", 2, "tropical", "America/Sao_Paulo"),
  Guyana: P("latin_america", 1, "tropical", "America/Guyana"),
  Suriname: P("latin_america", 1, "tropical", "America/Paramaribo"),

  // Western/Northern Europe
  "United Kingdom": P("europe", 4, "temperate", "Europe/London"),
  Ireland: P("europe", 4, "temperate", "Europe/Dublin"),
  France: P("europe", 4, "temperate", "Europe/Paris"),
  Germany: P("europe", 4, "temperate", "Europe/Berlin"),
  Netherlands: P("europe", 4, "temperate", "Europe/Amsterdam"),
  Belgium: P("europe", 4, "temperate", "Europe/Brussels"),
  Luxembourg: P("europe", 5, "temperate", "Europe/Luxembourg"),
  Switzerland: P("europe", 5, "cold", "Europe/Zurich"),
  Austria: P("europe", 4, "cold", "Europe/Vienna"),
  Denmark: P("europe", 5, "cold", "Europe/Copenhagen"),
  Norway: P("europe", 5, "cold", "Europe/Oslo"),
  Sweden: P("europe", 4, "cold", "Europe/Stockholm"),
  Finland: P("europe", 4, "cold", "Europe/Helsinki"),
  Iceland: P("europe", 5, "cold", "Atlantic/Reykjavik"),

  // Southern Europe
  Spain: P("europe", 3, "mediterranean", "Europe/Madrid"),
  Portugal: P("europe", 3, "mediterranean", "Europe/Lisbon"),
  Italy: P("europe", 3, "mediterranean", "Europe/Rome"),
  Greece: P("europe", 3, "mediterranean", "Europe/Athens"),
  Malta: P("europe", 3, "mediterranean", "Europe/Malta"),
  Cyprus: P("europe", 3, "mediterranean", "Asia/Nicosia"),
  Croatia: P("europe", 3, "mediterranean", "Europe/Zagreb"),
  Slovenia: P("europe", 3, "temperate", "Europe/Ljubljana"),
  Montenegro: P("europe", 2, "mediterranean", "Europe/Podgorica"),

  // Central/Eastern Europe
  Poland: P("europe", 2, "temperate", "Europe/Warsaw"),
  "Czech Republic": P("europe", 3, "temperate", "Europe/Prague"),
  Slovakia: P("europe", 2, "temperate", "Europe/Bratislava"),
  Hungary: P("europe", 2, "temperate", "Europe/Budapest"),
  Romania: P("europe", 2, "temperate", "Europe/Bucharest"),
  Bulgaria: P("europe", 2, "temperate", "Europe/Sofia"),
  Serbia: P("europe", 2, "temperate", "Europe/Belgrade"),
  Albania: P("europe", 1, "mediterranean", "Europe/Tirane"),
  "North Macedonia": P("europe", 1, "temperate", "Europe/Skopje"),
  "Bosnia and Herzegovina": P("europe", 1, "temperate", "Europe/Sarajevo"),
  Estonia: P("europe", 3, "cold", "Europe/Tallinn"),
  Latvia: P("europe", 2, "cold", "Europe/Riga"),
  Lithuania: P("europe", 2, "cold", "Europe/Vilnius"),
  Ukraine: P("europe", 1, "temperate", "Europe/Kyiv"),
  Belarus: P("europe", 1, "temperate", "Europe/Minsk"),
  Moldova: P("europe", 1, "temperate", "Europe/Chisinau"),
  Georgia: P("central_asia", 2, "temperate", "Asia/Tbilisi"),
  Armenia: P("central_asia", 2, "temperate", "Asia/Yerevan"),
  Azerbaijan: P("central_asia", 2, "arid", "Asia/Baku"),
  Russia: P("europe", 2, "cold", "Europe/Moscow"),

  // Middle East
  Turkey: P("middle_east", 2, "mediterranean", "Europe/Istanbul"),
  Israel: P("middle_east", 4, "mediterranean", "Asia/Jerusalem"),
  Jordan: P("middle_east", 2, "arid", "Asia/Amman"),
  Lebanon: P("middle_east", 2, "mediterranean", "Asia/Beirut"),
  "United Arab Emirates": P("middle_east", 4, "arid", "Asia/Dubai"),
  Qatar: P("middle_east", 5, "arid", "Asia/Qatar"),
  "Saudi Arabia": P("middle_east", 3, "arid", "Asia/Riyadh"),
  Oman: P("middle_east", 3, "arid", "Asia/Muscat"),
  Bahrain: P("middle_east", 4, "arid", "Asia/Bahrain"),
  Kuwait: P("middle_east", 3, "arid", "Asia/Kuwait"),
  Egypt: P("africa", 1, "arid", "Africa/Cairo"),
  Iran: P("middle_east", 1, "arid", "Asia/Tehran"),

  // Africa
  Morocco: P("africa", 2, "arid", "Africa/Casablanca"),
  Tunisia: P("africa", 2, "mediterranean", "Africa/Tunis"),
  Algeria: P("africa", 1, "arid", "Africa/Algiers"),
  Senegal: P("africa", 1, "tropical", "Africa/Dakar"),
  "Ivory Coast": P("africa", 1, "tropical", "Africa/Abidjan"),
  Ghana: P("africa", 1, "tropical", "Africa/Accra"),
  Nigeria: P("africa", 1, "tropical", "Africa/Lagos"),
  Cameroon: P("africa", 1, "tropical", "Africa/Douala"),
  Ethiopia: P("africa", 1, "temperate", "Africa/Addis_Ababa"),
  Kenya: P("africa", 2, "tropical", "Africa/Nairobi"),
  Tanzania: P("africa", 2, "tropical", "Africa/Dar_es_Salaam"),
  Uganda: P("africa", 1, "tropical", "Africa/Kampala"),
  Rwanda: P("africa", 2, "temperate", "Africa/Kigali"),
  Zambia: P("africa", 1, "tropical", "Africa/Lusaka"),
  Zimbabwe: P("africa", 1, "tropical", "Africa/Harare"),
  Botswana: P("africa", 2, "arid", "Africa/Gaborone"),
  Namibia: P("africa", 2, "arid", "Africa/Windhoek"),
  "South Africa": P("africa", 2, "temperate", "Africa/Johannesburg"),
  Mozambique: P("africa", 1, "tropical", "Africa/Maputo"),
  Madagascar: P("africa", 1, "tropical", "Indian/Antananarivo"),
  Mauritius: P("africa", 3, "tropical", "Indian/Mauritius"),
  Seychelles: P("africa", 4, "tropical", "Indian/Mahe"),

  // South Asia
  India: P("south_asia", 1, "tropical", "Asia/Kolkata"),
  Pakistan: P("south_asia", 1, "arid", "Asia/Karachi"),
  Bangladesh: P("south_asia", 1, "tropical", "Asia/Dhaka"),
  "Sri Lanka": P("south_asia", 1, "tropical", "Asia/Colombo"),
  Nepal: P("south_asia", 1, "temperate", "Asia/Kathmandu"),
  Bhutan: P("south_asia", 2, "cold", "Asia/Thimphu"),
  Maldives: P("south_asia", 5, "tropical", "Indian/Maldives"),

  // Central Asia
  Kazakhstan: P("central_asia", 2, "arid", "Asia/Almaty"),
  Uzbekistan: P("central_asia", 1, "arid", "Asia/Tashkent"),
  Kyrgyzstan: P("central_asia", 1, "cold", "Asia/Bishkek"),
  Mongolia: P("central_asia", 1, "cold", "Asia/Ulaanbaatar"),

  // East Asia
  Japan: P("east_asia", 4, "temperate", "Asia/Tokyo"),
  "South Korea": P("east_asia", 3, "temperate", "Asia/Seoul"),
  China: P("east_asia", 2, "temperate", "Asia/Shanghai"),
  Taiwan: P("east_asia", 3, "mediterranean", "Asia/Taipei"),
  "Hong Kong": P("east_asia", 4, "tropical", "Asia/Hong_Kong"),
  Macau: P("east_asia", 4, "tropical", "Asia/Macau"),

  // Southeast Asia
  Thailand: P("southeast_asia", 1, "tropical", "Asia/Bangkok"),
  Vietnam: P("southeast_asia", 1, "tropical", "Asia/Ho_Chi_Minh"),
  Cambodia: P("southeast_asia", 1, "tropical", "Asia/Phnom_Penh"),
  Laos: P("southeast_asia", 1, "tropical", "Asia/Vientiane"),
  Myanmar: P("southeast_asia", 1, "tropical", "Asia/Yangon"),
  Malaysia: P("southeast_asia", 2, "tropical", "Asia/Kuala_Lumpur"),
  Singapore: P("southeast_asia", 4, "tropical", "Asia/Singapore"),
  Indonesia: P("southeast_asia", 1, "tropical", "Asia/Jakarta"),
  Philippines: P("southeast_asia", 1, "tropical", "Asia/Manila"),
  Brunei: P("southeast_asia", 3, "tropical", "Asia/Brunei"),

  // Oceania
  Australia: P("oceania", 4, "arid", "Australia/Sydney"),
  "New Zealand": P("oceania", 4, "temperate", "Pacific/Auckland"),
  Fiji: P("oceania", 2, "tropical", "Pacific/Fiji"),
  "Papua New Guinea": P("oceania", 1, "tropical", "Pacific/Port_Moresby"),
  Samoa: P("oceania", 2, "tropical", "Pacific/Apia"),
  "French Polynesia": P("oceania", 4, "tropical", "Pacific/Tahiti"),
};

export function countryProfile(country: string): CountryProfile {
  const profile = COUNTRY_PROFILES[country];
  if (!profile) {
    throw new Error(`No CountryProfile for "${country}" — add one to src/domain/geography.ts.`);
  }
  return profile;
}

const BEST_MONTHS_BY_HEMISPHERE_AND_CLIMATE: Record<"northern" | "southern", Record<ClimateZone, number[]>> = {
  northern: {
    tropical: [12, 1, 2, 3],
    arid: [3, 4, 10, 11],
    mediterranean: [4, 5, 9, 10],
    temperate: [5, 6, 9],
    cold: [6, 7, 8],
  },
  southern: {
    tropical: [6, 7, 8, 9],
    arid: [9, 10, 3, 4],
    mediterranean: [10, 11, 3, 4],
    temperate: [11, 12, 3],
    cold: [12, 1, 2],
  },
};

const SOUTHERN_HEMISPHERE_TIME_ZONE_PREFIXES = [
  "Africa/Johannesburg",
  "Africa/Windhoek",
  "Africa/Gaborone",
  "Africa/Maputo",
  "Africa/Harare",
  "Africa/Lusaka",
  "Indian/Antananarivo",
  "Indian/Mauritius",
  "America/Sao_Paulo",
  "America/Argentina",
  "America/Santiago",
  "America/Montevideo",
  "America/Asuncion",
  "America/La_Paz",
  "America/Lima",
  "Pacific/Auckland",
  "Pacific/Fiji",
  "Pacific/Apia",
  "Pacific/Tahiti",
  "Pacific/Port_Moresby",
  "Australia",
];

/** Coarse hemisphere guess from the country's representative time zone — good enough for a seasonality hint, not a real geodata lookup. */
function hemisphereOf(timeZone: string): "northern" | "southern" {
  return SOUTHERN_HEMISPHERE_TIME_ZONE_PREFIXES.some((prefix) => timeZone.startsWith(prefix))
    ? "southern"
    : "northern";
}

export function deriveSeasonality(country: string): { best_months: number[] } {
  const profile = countryProfile(country);
  const hemisphere = hemisphereOf(profile.timeZone);
  return { best_months: BEST_MONTHS_BY_HEMISPHERE_AND_CLIMATE[hemisphere][profile.climateZone] };
}

const DAILY_COST_BY_TIER: Record<1 | 2 | 3 | 4 | 5, [number, number]> = {
  1: [40, 70],
  2: [65, 100],
  3: [90, 140],
  4: [130, 200],
  5: [190, 320],
};

export function dailyCostRangeUsd(country: string): [number, number] {
  return DAILY_COST_BY_TIER[countryProfile(country).costTier];
}

const VIBE_TAGS_BY_CLIMATE: Record<ClimateZone, string[]> = {
  tropical: ["beach", "nature", "coastal"],
  arid: ["desert", "adventure", "history"],
  mediterranean: ["coastal", "food", "culture"],
  temperate: ["walkable", "food", "culture"],
  cold: ["outdoors", "adventure", "nature"],
};

const VIBE_TAGS_BY_REGION: Record<Region, string[]> = {
  north_america: ["family", "nightlife"],
  latin_america: ["nightlife", "history"],
  europe: ["culture", "history"],
  africa: ["wildlife", "outdoors"],
  middle_east: ["history", "culture"],
  south_asia: ["culture", "food"],
  east_asia: ["culture", "food"],
  southeast_asia: ["beach", "food"],
  central_asia: ["history", "adventure"],
  oceania: ["nature", "outdoors"],
};

export function deriveVibeTags(country: string): string[] {
  const profile = countryProfile(country);
  return [...new Set([...VIBE_TAGS_BY_CLIMATE[profile.climateZone], ...VIBE_TAGS_BY_REGION[profile.region]])];
}

/**
 * Rough long-haul-vs-short-haul price/duration scaling for the flight
 * generator — not real distance, just a per-region multiplier so, e.g., a
 * Southeast Asian route doesn't cost the same as a transatlantic one.
 */
const HAUL_MULTIPLIER_BY_REGION: Record<Region, number> = {
  north_america: 1,
  latin_america: 1.1,
  europe: 1.3,
  africa: 1.5,
  middle_east: 1.4,
  south_asia: 1.6,
  east_asia: 1.7,
  southeast_asia: 1.7,
  central_asia: 1.6,
  oceania: 1.9,
};

export function haulMultiplier(country: string): number {
  return HAUL_MULTIPLIER_BY_REGION[countryProfile(country).region];
}
