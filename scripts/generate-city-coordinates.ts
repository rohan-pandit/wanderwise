/**
 * One-time (re-runnable) generator for `src/domain/city-coordinates-data.ts`
 * — a broad, real, public-domain city-name -> lat/long dataset used to resolve
 * a city with no scheduled-commercial airport of its own (`origin` or
 * `destination`) to real geographic coordinates, so `findNearestAirport`
 * (`src/domain/airport-lookup.ts`) has something to measure distance from.
 * Built 2026-09-22 after finding a real trip's destination ("Sintra,
 * Portugal" — real, seeded, correctly resolved, but with no airport of its
 * own anywhere near it in `scheduled_service` terms) failed with no
 * fallback at all: the flight step could only ever throw `UnknownAirportError`
 * for a city like this, with no notion of "the nearest real airport is
 * actually X."
 *
 * Source: GeoNames' public-domain (CC BY 4.0) `cities15000.zip`
 * (https://download.geonames.org/export/dump/ — every city with population
 * > 15,000, or a national capital regardless of population, ~34k rows).
 * Chosen over a narrower hand-curated list for the same reason
 * `generate-airport-data.ts` uses a real public dataset instead of
 * hand-typed airport info: verifiable, broad (covers far more cities than
 * this app's own ~640-destination seed catalog, so an arbitrary user-typed
 * origin has real odds of resolving too, not just a seeded destination),
 * and reproducible by re-running this script rather than trusting anyone's
 * memory of world geography.
 *
 * Only the fields this app actually needs are kept (name, country,
 * lat/long, population) — GeoNames' own feature/admin codes, alternate
 * names, elevation, and per-row timezone are all dropped, cutting the
 * ~34,000-row source from several MB down to a fraction of that.
 *
 * GeoNames' own primary `name`/`asciiname` for some cities is the
 * native-language form, not the common English name a traveler (or this
 * app's own seed catalog) would type — "Köln" for Cologne, "Frankfurt am
 * Main" for Frankfurt. Tried indexing every qualifying Latin-script
 * alternate name to close this generally (found live 2026-09-22); reverted
 * — GeoNames' `alternatenames` blob has no per-entry language tag in this
 * file, so even a same-script filter let through enough historical/
 * multi-language noise to grow the dataset 6x (34k -> 220k rows) for
 * marginal real benefit. `src/domain/geocoding.ts`'s small, hand-curated
 * `COMMON_NAME_ALIASES` handles the specific, real cases that actually
 * matter to this app's own seed catalog instead — each one verified
 * against this exact dataset, not guessed.
 *
 * Usage: `npm run generate-city-coordinates`
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { countryName } from "./lib/country-names";

const SOURCE_URL = "https://download.geonames.org/export/dump/cities15000.zip";
const SOURCE_ENTRY = "cities15000.txt";
const OUTPUT_PATH = path.join(import.meta.dirname, "../src/domain/city-coordinates-data.ts");

export interface CityEntry {
  /** GeoNames' `asciiname` — plain ASCII, matching how this app's own seed data and user-typed city names are written (no diacritics), rather than `name`, which preserves the local script/accents. */
  name: string;
  country: string;
  lat: number;
  lon: number;
  population: number;
}

async function main() {
  console.log(`Fetching ${SOURCE_URL} ...`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const zip = new AdmZip(buf);
  const entry = zip.getEntry(SOURCE_ENTRY);
  if (!entry) throw new Error(`${SOURCE_ENTRY} not found in the downloaded zip`);
  const raw = entry.getData().toString("utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  // GeoNames' plain "geoname" table format (tab-separated, no header row):
  // geonameid, name, asciiname, alternatenames, latitude, longitude,
  // feature class, feature code, country code, cc2, admin1 code,
  // admin2 code, admin3 code, admin4 code, population, elevation, dem,
  // timezone, modification date.
  const entries: CityEntry[] = [];
  for (const line of lines) {
    const f = line.split("\t");
    const asciiname = f[2];
    const lat = Number(f[4]);
    const lon = Number(f[5]);
    const countryCode = f[8];
    const population = Number(f[14]) || 0;
    if (!asciiname || !countryCode || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    entries.push({ name: asciiname, country: countryName(countryCode), lat, lon, population });
  }

  // Highest population first per (name, country) pair — the lookup this
  // feeds (`findCityCoordinates`, `src/domain/geocoding.ts`) takes the
  // first match it finds for a
  // given name, so ordering by population up front means an ambiguous
  // common name resolves to its best-known real place, not an arbitrary
  // smaller town that happens to share it.
  entries.sort((a, b) => b.population - a.population);

  const body = entries
    .map((e) => `  [${JSON.stringify(e.name)}, ${JSON.stringify(e.country)}, ${e.lat}, ${e.lon}, ${e.population}]`)
    .join(",\n");

  const output = `/**
 * Generated by `+"`npm run generate-city-coordinates`"+` (`+"`scripts/generate-city-coordinates.ts`"+`) —
 * do not hand-edit. Source: GeoNames' public-domain (CC BY 4.0)
 * \`cities15000.zip\` (every city with population > 15,000, or a national
 * capital regardless of population). See that script's header comment for
 * the full provenance/filtering notes. Consumed by
 * `+"`src/domain/geocoding.ts`"+`, never imported directly.
 *
 * Tuple shape: [name, country, lat, lon, population] — an array of tuples
 * rather than objects to keep this ${entries.length}-row file's parse cost
 * down (no repeated key names). Sorted by population descending, so the
 * first match for an ambiguous bare name (no country given) is its
 * best-known real place.
 */
export const CITY_COORDINATES_RAW: readonly [name: string, country: string, lat: number, lon: number, population: number][] = [
${body},
];
`;

  writeFileSync(OUTPUT_PATH, output);
  console.log(`Wrote ${entries.length} cities to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
