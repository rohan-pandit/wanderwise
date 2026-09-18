/**
 * One-time (re-runnable) generator for `src/domain/airport-data.ts` — the
 * static dataset backing airport-code resolution for the SerpAPI Google
 * Flights integration (`docs/IMPLEMENTATION_PLAN.md`'s live-flight-inventory
 * work), since that API takes IATA airport codes, not city names.
 *
 * Source: OurAirports' public-domain `airports.csv`
 * (https://ourairports.com/data/ — mirrored at
 * https://davidmegginson.github.io/ourairports-data/airports.csv), filtered
 * to airports with a real IATA code and `scheduled_service = "yes"` (i.e.
 * airports that actually run scheduled commercial flights — excludes the
 * ~80,000 small/private/closed airfields the raw dataset also contains).
 * Country names are normalized from the source's ISO 3166-1 alpha-2 codes to
 * the full names `src/domain/geography.ts`'s `COUNTRY_PROFILES` already uses
 * (via `Intl.DisplayNames`, plus a small override table for the handful of
 * cases where that disagrees with this codebase's existing spelling, e.g.
 * "Czechia" vs. "Czech Republic") — this file's `country` field is a display
 * string in the same vocabulary as `destinations.country`, not an ISO code.
 *
 * Usage: `npm run generate-airport-data`
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

const SOURCE_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";
/**
 * OurAirports doesn't include an IANA time zone per airport, and every
 * generated `Flight` needs one (`deriveHotelStayDates`,
 * `src/domain/stay.ts`, depends on the flight's own local arrival/departure
 * date, not just a bare timestamp) — SerpAPI's own response only gives a
 * bare local "YYYY-MM-DD HH:MM" string per leg with no offset at all.
 * OpenFlights' separate `airports.dat` has exactly this ("Tz database time
 * zone", e.g. "America/New_York"), keyed by the same IATA code, so it's
 * merged in by IATA code rather than switched to as the primary source —
 * OurAirports' `scheduled_service`/`type` fields (the actual filter this
 * script needs) don't exist in OpenFlights' file.
 */
const TZ_SOURCE_URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airports.dat";
const OUTPUT_PATH = path.join(import.meta.dirname, "../src/domain/airport-data.ts");

const EXCLUDED_TYPES = new Set(["closed", "heliport", "seaplane_base", "balloonport"]);

/** Corrects the handful of `Intl.DisplayNames` outputs that don't match this codebase's existing country-name spelling (`src/domain/geography.ts`'s `COUNTRY_PROFILES` keys) — found by cross-checking every code in the filtered dataset against that list. */
const COUNTRY_NAME_OVERRIDES: Record<string, string> = {
  BS: "The Bahamas",
  CI: "Ivory Coast",
  CZ: "Czech Republic",
  HK: "Hong Kong",
  MO: "Macau",
  TR: "Turkey",
};

function countryName(iso2: string): string {
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

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

export interface AirportEntry {
  iata: string;
  name: string;
  city: string;
  country: string;
  tz: string;
}

/** OpenFlights' `airports.dat` is plain (unquoted-mostly) CSV with `\N` for a genuinely missing value — returns `iata -> Tz database time zone`. */
async function fetchIataToTz(): Promise<Map<string, string>> {
  console.log(`Fetching ${TZ_SOURCE_URL} ...`);
  const res = await fetch(TZ_SOURCE_URL);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const raw = await res.text();
  const map = new Map<string, string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const f = parseCsvLine(line);
    const iata = f[4]; // 0-indexed: ID, Name, City, Country, IATA, ICAO, Lat, Lon, Alt, Timezone(offset), DST, Tz database time zone, ...
    const tz = f[11];
    if (iata && iata !== "\\N" && tz && tz !== "\\N") map.set(iata, tz);
  }
  return map;
}

async function main() {
  const iataToTz = await fetchIataToTz();

  console.log(`Fetching ${SOURCE_URL} ...`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const raw = await res.text();
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  const seen = new Set<string>();
  const entries: AirportEntry[] = [];
  let missingTz = 0;
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    const type = f[idx.type];
    const iata = f[idx.iata_code];
    const scheduled = f[idx.scheduled_service];
    const city = f[idx.municipality];
    if (!iata || iata.length !== 3) continue;
    if (scheduled !== "yes") continue;
    if (EXCLUDED_TYPES.has(type)) continue;
    if (!city) continue; // unusable for city-name lookup
    if (seen.has(iata)) continue; // a handful of duplicate IATA rows exist in the source
    const tz = iataToTz.get(iata);
    if (!tz) {
      missingTz++;
      continue; // unusable without a time zone -- can't build a correct Flight row without one
    }
    seen.add(iata);

    entries.push({
      iata,
      name: f[idx.name],
      city,
      country: countryName(f[idx.iso_country]),
      tz,
    });
  }
  entries.sort((a, b) => a.iata.localeCompare(b.iata));

  console.log(
    `${lines.length - 1} raw rows -> ${entries.length} scheduled-commercial airports with a usable city and time zone ` +
      `(${missingTz} otherwise-usable airports dropped for having no match in OpenFlights' time zone data).`,
  );

  const body = entries
    .map(
      (e) =>
        `  [${JSON.stringify(e.iata)}, ${JSON.stringify(e.name)}, ${JSON.stringify(e.city)}, ${JSON.stringify(e.country)}, ${JSON.stringify(e.tz)}]`,
    )
    .join(",\n");

  const output = `/**
 * Generated by `+"`npm run generate-airport-data`"+` (`+"`scripts/generate-airport-data.ts`"+`) —
 * do not hand-edit. Source: OurAirports' public-domain airports.csv,
 * filtered to scheduled-commercial airports with a real IATA code. See that
 * script's header comment for the full provenance/filtering/normalization
 * notes. Consumed by `+"`src/domain/airport-lookup.ts`"+`, never imported directly.
 *
 * Tuple shape: [iata, name, city, country, tz] — an array of tuples rather
 * than objects to keep this ${entries.length}-row file's parse cost down (no
 * repeated key names). \`tz\` is an IANA time zone (e.g. "America/New_York"),
 * merged in from OpenFlights' separate dataset — see this script's header
 * comment for why.
 */
export const AIRPORTS_RAW: readonly [iata: string, name: string, city: string, country: string, tz: string][] = [
${body},
];
`;

  writeFileSync(OUTPUT_PATH, output);
  console.log(`Wrote ${entries.length} airports to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
