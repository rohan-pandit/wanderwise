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
 * Timezone is computed directly from each airport's own lat/long via
 * `tz-lookup` (a small, fully offline lat/long -> IANA-timezone library —
 * no network call, no second dataset). This replaces an earlier version of
 * this script that cross-referenced OpenFlights' `airports.dat` by IATA
 * code for timezone instead: that dataset hasn't been actively maintained
 * since ~2017, so a real, currently-operating airport with no match in it
 * (found live 2026-09-22: Istanbul Airport / IST, opened 2018, replacing
 * the older Atatürk Airport OpenFlights still lists) was silently dropped
 * from the generated file entirely — not a naming mismatch, a genuine
 * missing-airport gap. Computing timezone from coordinates instead needs no
 * second source and can't go stale the same way.
 *
 * Usage: `npm run generate-airport-data`
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import tzlookup from "tz-lookup";
import { countryName } from "./lib/country-names";

const SOURCE_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const OUTPUT_PATH = path.join(import.meta.dirname, "../src/domain/airport-data.ts");

const EXCLUDED_TYPES = new Set(["closed", "heliport", "seaplane_base", "balloonport"]);

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
  lat: number;
  lon: number;
  /** OurAirports' own size class — see `AirportSize` in `src/domain/airport-lookup.ts` for how it's used. */
  size: "large" | "medium" | "small";
}

async function main() {
  console.log(`Fetching ${SOURCE_URL} ...`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const raw = await res.text();
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  const header = parseCsvLine(lines[0]);
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  const seen = new Set<string>();
  const entries: AirportEntry[] = [];
  let skippedBadCoords = 0;
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

    const lat = Number(f[idx.latitude_deg]);
    const lon = Number(f[idx.longitude_deg]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      skippedBadCoords++;
      continue; // can't compute a timezone, or serve as a nearest-airport candidate, without real coordinates
    }

    let tz: string;
    try {
      tz = tzlookup(lat, lon);
    } catch {
      skippedBadCoords++;
      continue; // tz-lookup throws for coordinates outside any known timezone boundary (e.g. open ocean) — shouldn't happen for a real airport, but don't let one bad row crash the whole generator
    }
    seen.add(iata);

    entries.push({
      iata,
      name: f[idx.name],
      city,
      country: countryName(f[idx.iso_country]),
      tz,
      lat,
      lon,
      size: type === "large_airport" ? "large" : type === "medium_airport" ? "medium" : "small",
    });
  }
  entries.sort((a, b) => a.iata.localeCompare(b.iata));

  console.log(
    `${lines.length - 1} raw rows -> ${entries.length} scheduled-commercial airports with a usable city and coordinates ` +
      `(${skippedBadCoords} otherwise-usable airports dropped for missing/invalid coordinates).`,
  );

  const body = entries
    .map(
      (e) =>
        `  [${JSON.stringify(e.iata)}, ${JSON.stringify(e.name)}, ${JSON.stringify(e.city)}, ${JSON.stringify(e.country)}, ${JSON.stringify(e.tz)}, ${e.lat}, ${e.lon}, ${JSON.stringify(e.size)}]`,
    )
    .join(",\n");

  const output = `/**
 * Generated by `+"`npm run generate-airport-data`"+` (`+"`scripts/generate-airport-data.ts`"+`) —
 * do not hand-edit. Source: OurAirports' public-domain airports.csv,
 * filtered to scheduled-commercial airports with a real IATA code. See that
 * script's header comment for the full provenance/filtering/normalization
 * notes. Consumed by `+"`src/domain/airport-lookup.ts`"+`, never imported directly.
 *
 * Tuple shape: [iata, name, city, country, tz, lat, lon, size] — an array of
 * tuples rather than objects to keep this ${entries.length}-row file's parse
 * cost down (no repeated key names). \`tz\` is an IANA time zone (e.g.
 * "America/New_York"), computed directly from \`lat\`/\`lon\` via \`tz-lookup\`
 * (see this script's header comment for why, not cross-referenced from a
 * second dataset). \`lat\`/\`lon\` are also used directly for nearest-airport
 * fallback resolution (\`findNearestAirport\`, \`airport-lookup.ts\`) when a
 * city has no scheduled-commercial airport of its own. \`size\` is OurAirports'
 * own large/medium/small class, which that fallback uses to prefer a real hub
 * over a closer, barely-served airfield.
 */
export const AIRPORTS_RAW: readonly [iata: string, name: string, city: string, country: string, tz: string, lat: number, lon: number, size: "large" | "medium" | "small"][] = [
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
