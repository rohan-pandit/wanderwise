/**
 * One-time (re-runnable) large-scale seed data generator. Adds ~637 real
 * destinations (`scripts/data/cities.ts`) on top of — never replacing — the
 * app's 6 hand-curated original destinations and their fixtures
 * (`supabase/migrations/0002_seed_data.sql`), plus dense, categorized
 * hotels/activities for each new destination. `docs/IMPLEMENTATION_PLAN.md`
 * and `BUILD_LOG.md` cover the "why" (a manual testing pass needs enough
 * inventory that running out of options isn't the norm).
 *
 * Idempotent by construction, at city granularity: a destination whose exact
 * name already exists at `CURRENT_INVENTORY_VERSION` is skipped entirely
 * (destination + hotels + activities), so a re-run after a partial failure
 * only processes whatever wasn't already inserted. Flights are NOT seeded
 * here — see `src/domain/flight-generator.ts` for why (generated on demand
 * at search time instead of pre-seeded, since literal per-date rows can't
 * cover arbitrary future dates at this destination count).
 *
 * Deterministic: every generated field is derived from a PRNG seeded by the
 * city's own name (`src/domain/random.ts`), so re-running against the same
 * city list reproduces the same catalog.
 *
 * Usage: `npm run generate-large-seed-data`
 */
import type { Database } from "../src/config/supabase/database.types";
import { createServiceClient } from "../src/config/supabase/service";
import { CURRENT_INVENTORY_VERSION } from "../src/domain/inventory";
import { seededRng } from "../src/domain/random";
import { deriveSeasonality, deriveVibeTags, countryProfile } from "../src/domain/geography";
import { CITIES_BY_COUNTRY } from "./data/cities";
import {
  generateDestinationDescription,
  generateEstimatedDailyCostUsd,
  generateHotel,
  hotelCountForDestination,
  generateActivity,
  planActivitiesForDestination,
} from "./data/inventory-templates";

const supabase = createServiceClient();
const CHUNK_SIZE = 25;

interface CitySeed {
  name: string;
  country: string;
}

function allCitySeeds(): CitySeed[] {
  return Object.entries(CITIES_BY_COUNTRY).flatMap(([country, cities]) =>
    cities.map((name) => ({ name, country })),
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function existingDestinationNames(): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("destinations")
    .select("name")
    .eq("inventory_version", CURRENT_INVENTORY_VERSION);
  if (error) throw error;
  return new Set(data.map((row) => row.name));
}

async function main() {
  // Fail fast on a bad country key or a city name colliding with itself —
  // cheaper to catch here than partway through a real insert run.
  const seeds = allCitySeeds();
  for (const seed of seeds) countryProfile(seed.country); // throws if unknown

  const existing = await existingDestinationNames();
  const toCreate = seeds.filter((seed) => !existing.has(seed.name));
  console.log(`${seeds.length} candidate cities, ${existing.size} destinations already present, ${toCreate.length} to create.`);

  let destinationsCreated = 0;
  let hotelsCreated = 0;
  let activitiesCreated = 0;

  for (const batch of chunk(toCreate, CHUNK_SIZE)) {
    const destinationRows = batch.map((seed) => ({
      name: seed.name,
      country: seed.country,
      time_zone: countryProfile(seed.country).timeZone,
      description: generateDestinationDescription(seededRng(`dest:${seed.name}`), seed.name, seed.country),
      vibe_tags: deriveVibeTags(seed.country),
      seasonality: deriveSeasonality(seed.country),
      estimated_daily_cost_usd: generateEstimatedDailyCostUsd(seededRng(`cost:${seed.name}`), seed.country),
      inventory_version: CURRENT_INVENTORY_VERSION,
      source: "seed",
    }));

    const { data: insertedDestinations, error: destinationError } = await supabase
      .from("destinations")
      .insert(destinationRows)
      .select("id, name, country");
    if (destinationError) throw destinationError;
    destinationsCreated += insertedDestinations.length;

    const hotelRows: Database["public"]["Tables"]["hotels"]["Insert"][] = [];
    const activityRows: Database["public"]["Tables"]["activities"]["Insert"][] = [];

    for (const destination of insertedDestinations) {
      const hotelRng = seededRng(`hotels:${destination.name}`);
      const { count: hotelCount, sparse } = hotelCountForDestination(hotelRng);
      for (let i = 0; i < hotelCount; i++) {
        const hotel = generateHotel(hotelRng, destination.name, destination.country ?? "", sparse);
        hotelRows.push({
          destination: destination.name,
          destination_id: destination.id,
          inventory_version: CURRENT_INVENTORY_VERSION,
          ...hotel,
        });
      }

      const activityRng = seededRng(`activities:${destination.name}`);
      const plan = planActivitiesForDestination(activityRng, sparse);
      for (const { category, count } of plan) {
        for (let i = 0; i < count; i++) {
          const activity = generateActivity(activityRng, destination.name, destination.country ?? "", category);
          activityRows.push({
            destination: destination.name,
            destination_id: destination.id,
            inventory_version: CURRENT_INVENTORY_VERSION,
            ...activity,
          });
        }
      }
    }

    if (hotelRows.length > 0) {
      const { error: hotelError } = await supabase.from("hotels").insert(hotelRows);
      if (hotelError) throw hotelError;
      hotelsCreated += hotelRows.length;
    }
    if (activityRows.length > 0) {
      const { error: activityError } = await supabase.from("activities").insert(activityRows);
      if (activityError) throw activityError;
      activitiesCreated += activityRows.length;
    }

    console.log(
      `Batch done: +${insertedDestinations.length} destinations, +${hotelRows.length} hotels, +${activityRows.length} activities ` +
        `(running totals: ${destinationsCreated} / ${hotelsCreated} / ${activitiesCreated})`,
    );
  }

  console.log(
    `Done. Created ${destinationsCreated} destinations, ${hotelsCreated} hotels, ${activitiesCreated} activities. ` +
      `Run "npm run generate-embeddings" next to embed the new destinations/activities.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
