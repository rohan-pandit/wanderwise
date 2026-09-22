/**
 * One-time (re-runnable) backfill: resolves each current-inventory-version
 * `destinations` row to a real GeoNames admin1 region name (e.g. "Tuscany",
 * "Bavaria") and writes it to the new `destinations.region` column
 * (`supabase/migrations/0019_destination_regions.sql`). Closes the "Tuscany"
 * gap (`docs/IMPLEMENTATION_PLAN.md` §5): a real named region with genuinely
 * matching inventory (Florence/Siena/Pisa are all seeded) used to produce a
 * false "we don't have that destination" instead of a "which city?"
 * clarification, since nothing connected the region name to its cities —
 * `checkDestinationReadiness` (`src/workflow/step-shared.ts`) now reads this
 * column via `listDestinationRegions`/`listDestinationsByRegion`
 * (`src/repositories/destinations.ts`).
 *
 * Deliberately self-contained rather than extending
 * `generate-city-coordinates.ts`'s bundled runtime dataset: admin1 code is
 * only ever needed at backfill time, not by anything the running app reads,
 * so adding it to `city-coordinates-data.ts` (shipped in the app bundle)
 * would bloat a runtime dataset for a build-time-only need. This script
 * fetches its own copy of the same two GeoNames sources instead:
 *
 * - `cities15000.zip` (same source `generate-city-coordinates.ts` uses) —
 *   for each destination's admin1 code, matched by (asciiname, country).
 * - `admin1CodesASCII.txt` — GeoNames' own admin1-code -> display-name table
 *   (e.g. "IT.16" -> "Tuscany"), fetched fresh rather than bundled, since
 *   it's only consulted here, once, not at runtime.
 *
 * Idempotent by construction, same as `generate-embeddings.ts`: re-running
 * just recomputes and overwrites every destination's `region`.
 *
 * Usage: `npm run generate-destination-regions`
 */
import AdmZip from "adm-zip";
import type { Database } from "../src/config/supabase/database.types";
import { createServiceClient } from "../src/config/supabase/service";
import { COMMON_NAME_ALIASES } from "../src/domain/geocoding";
import { CURRENT_INVENTORY_VERSION } from "../src/domain/inventory";
import { isUsStateName } from "../src/domain/region-names";
import { countryName } from "./lib/country-names";

const CITIES_URL = "https://download.geonames.org/export/dump/cities15000.zip";
const CITIES_ENTRY = "cities15000.txt";
const ADMIN1_URL = "https://download.geonames.org/export/dump/admin1CodesASCII.txt";

const supabase = createServiceClient();
const PAGE_SIZE = 1000;
const UPDATE_CONCURRENCY = 20;

interface CityAdmin1Entry {
  admin1Key: string; // "<countryCode>.<admin1Code>"
  population: number;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** GeoNames' plain "geoname" tab-separated dump — see `generate-city-coordinates.ts` for the full column layout; this script only needs asciiname, country code, admin1 code, and population. */
async function fetchCityAdmin1Map(): Promise<Map<string, CityAdmin1Entry>> {
  console.log(`Fetching ${CITIES_URL} ...`);
  const res = await fetch(CITIES_URL);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const zip = new AdmZip(buf);
  const entry = zip.getEntry(CITIES_ENTRY);
  if (!entry) throw new Error(`${CITIES_ENTRY} not found in the downloaded zip`);
  const raw = entry.getData().toString("utf8");

  // Keyed by "<asciiname lowercased>|||<country full name lowercased>",
  // keeping the highest-population match when a (name, country) pair
  // appears more than once (mirrors generate-city-coordinates.ts's own
  // population-first disambiguation).
  const map = new Map<string, CityAdmin1Entry>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const f = line.split("\t");
    const asciiname = f[2];
    const countryCode = f[8];
    const admin1Code = f[10];
    const population = Number(f[14]) || 0;
    if (!asciiname || !countryCode || !admin1Code) continue;

    const key = `${normalize(asciiname)}|||${normalize(countryName(countryCode))}`;
    const existing = map.get(key);
    if (!existing || population > existing.population) {
      map.set(key, { admin1Key: `${countryCode}.${admin1Code}`, population });
    }
  }
  return map;
}

/** GeoNames' admin1-code -> display-name table (tab-separated: code, name, asciiname, geonameid). */
async function fetchAdmin1Names(): Promise<Map<string, string>> {
  console.log(`Fetching ${ADMIN1_URL} ...`);
  const res = await fetch(ADMIN1_URL);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const raw = await res.text();
  const map = new Map<string, string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const [code, name] = line.split("\t");
    if (code && name) map.set(code, name);
  }
  return map;
}

async function selectAllCurrentDestinations(): Promise<Database["public"]["Tables"]["destinations"]["Row"][]> {
  const rows: Database["public"]["Tables"]["destinations"]["Row"][] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("destinations")
      .select("*")
      .eq("inventory_version", CURRENT_INVENTORY_VERSION)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function main() {
  const [cityAdmin1Map, admin1Names, destinations] = await Promise.all([
    fetchCityAdmin1Map(),
    fetchAdmin1Names(),
    selectAllCurrentDestinations(),
  ]);
  console.log(`Resolving regions for ${destinations.length} destinations ...`);

  const resolved: { id: string; region: string }[] = [];
  const unresolved: string[] = [];
  const skippedUsState: string[] = [];

  for (const dest of destinations) {
    if (!dest.country) {
      unresolved.push(dest.name);
      continue;
    }
    const nameKey = normalize(dest.name);
    const aliasKey = normalize(COMMON_NAME_ALIASES[nameKey] ?? dest.name);
    const countryKey = normalize(dest.country);
    const cityEntry = cityAdmin1Map.get(`${nameKey}|||${countryKey}`) ?? cityAdmin1Map.get(`${aliasKey}|||${countryKey}`);
    const region = cityEntry ? admin1Names.get(cityEntry.admin1Key) : undefined;

    if (!region) {
      unresolved.push(dest.name);
      continue;
    }
    // US states already have their own dedicated, tested clarification path
    // (`checkOriginReadiness`/`checkDestinationReadiness`'s "state" handling)
    // that doesn't depend on this column — every US destination's admin1
    // region IS literally its US state name, so writing it here would just
    // be inert data, not a functional gap (the readiness check itself
    // already excludes `isUsStateName` matches from the "region" branch —
    // see that function's own comment for why). Skipped here too, simply to
    // avoid writing ~a third of this column with values nothing ever reads
    // — tracked separately from genuinely unresolved destinations below, so
    // this log doesn't conflate "found nothing" with "found something, but
    // deliberately didn't write it."
    if (isUsStateName(region)) {
      skippedUsState.push(dest.name);
      continue;
    }
    resolved.push({ id: dest.id, region });
  }

  console.log(`Resolved: ${resolved.length}/${destinations.length}.`);
  console.log(`Skipped as a US state region (by design, ${skippedUsState.length}): ${skippedUsState.join(", ")}`);
  console.log(`Genuinely unresolved (${unresolved.length}):\n${unresolved.join(", ")}`);

  for (let i = 0; i < resolved.length; i += UPDATE_CONCURRENCY) {
    const batch = resolved.slice(i, i + UPDATE_CONCURRENCY);
    await Promise.all(
      batch.map(({ id, region }) => supabase.from("destinations").update({ region }).eq("id", id).then(({ error }) => {
        if (error) throw error;
      })),
    );
  }

  const distinctRegions = [...new Set(resolved.map((r) => r.region))].sort();
  console.log(`Wrote ${resolved.length} region values across ${distinctRegions.length} distinct regions:\n${distinctRegions.join(", ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
